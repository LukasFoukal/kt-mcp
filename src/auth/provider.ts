/**
 * A minimal single-user OAuth 2.1 authorization server.
 *
 * The MCP spec makes this server an OAuth resource server, and Claude's custom
 * connector flow drives the full authorization-code + PKCE dance. We are the
 * only user, so "authorization" is: prove you know MCP_AUTH_PASSWORD in a
 * browser, once, and get a token.
 *
 * The SDK's `mcpAuthRouter` supplies the endpoints and discovery documents and
 * validates PKCE; this file supplies the storage and the consent screen.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { JsonStore } from './store.js';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const MCP_SCOPE = 'caltrack:log';

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  scopes: string[];
  expiresAt: number;
}

interface IssuedToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, IssuedToken>;
  refreshTokens: Record<string, IssuedToken>;
}

const EMPTY_STATE: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {} };

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison that tolerates differing lengths. */
function secretMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the failure cost doesn't leak the length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  private readonly store: JsonStore<PersistedState>;
  /** Authorization codes are short-lived; losing them on restart is fine. */
  private readonly pendingCodes = new Map<string, PendingCode>();

  constructor(
    private readonly loginPassword: string,
    stateFile: string,
  ) {
    this.store = new JsonStore(stateFile, EMPTY_STATE);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId: string) => {
        const clients = this.store.read().clients;
        // hasOwn guards all state lookups: keys arrive from the network, and
        // "__proto__" or "constructor" would otherwise return a truthy non-record.
        return Object.hasOwn(clients, clientId) ? clients[clientId] : undefined;
      },
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        this.store.update(state => {
          state.clients[full.client_id] = full;
        });
        return full;
      },
    };
  }

  /**
   * Renders the consent screen, then (on POST) mints an authorization code and
   * redirects back to Claude. The SDK routes both verbs here.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const req = res.req;
    const supplied = typeof req.body?.password === 'string' ? req.body.password : null;

    if (supplied === null) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(this.consentPage(client, params, null));
      return;
    }

    if (!secretMatches(supplied, this.loginPassword)) {
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(this.consentPage(client, params, 'Incorrect password.'));
      return;
    }

    const code = newToken();
    this.pendingCodes.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      scopes: params.scopes ?? [MCP_SCOPE],
      expiresAt: Date.now() + 60_000,
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state !== undefined) redirect.searchParams.set('state', params.state);
    res.redirect(redirect.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.pendingCodes.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code');
    }
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.pendingCodes.get(authorizationCode);
    this.pendingCodes.delete(authorizationCode);

    if (!pending || pending.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown or expired authorization code');
    }
    if (Date.now() > pending.expiresAt) {
      throw new InvalidGrantError('Authorization code has expired');
    }
    if (redirectUri !== undefined && redirectUri !== pending.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // RFC 8707: the token must be bound to the resource it was requested for.
    if (resource !== undefined && pending.resource !== undefined && resource.href !== pending.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }

    return this.issueTokens(client.client_id, pending.scopes, pending.resource ?? resource?.href);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshTokens = this.store.read().refreshTokens;
    const record = Object.hasOwn(refreshTokens, refreshToken) ? refreshTokens[refreshToken] : undefined;
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Unknown refresh token');
    }
    // Rotate: the presented refresh token is single-use.
    this.store.update(state => {
      delete state.refreshTokens[refreshToken];
    });
    if (Date.now() > record.expiresAt) {
      throw new InvalidGrantError('Refresh token has expired');
    }
    // The grant's scopes are fixed at authorization; a refresh cannot widen them.
    return this.issueTokens(client.client_id, record.scopes, record.resource ?? resource?.href);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const accessTokens = this.store.read().accessTokens;
    const record = Object.hasOwn(accessTokens, token) ? accessTokens[token] : undefined;
    if (!record) throw new InvalidTokenError('Unknown access token');
    if (Date.now() > record.expiresAt) {
      this.store.update(state => {
        delete state.accessTokens[token];
      });
      throw new InvalidTokenError('Access token has expired');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    this.store.update(state => {
      delete state.accessTokens[request.token];
      delete state.refreshTokens[request.token];
    });
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const expiresAt = Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000;

    this.store.update(state => {
      state.accessTokens[accessToken] = { clientId, scopes, resource, expiresAt };
      // Refresh tokens outlive access tokens; give them a generous window.
      state.refreshTokens[refreshToken] = {
        clientId,
        scopes,
        resource,
        expiresAt: expiresAt + ACCESS_TOKEN_TTL_SECONDS * 1000,
      };
      // Opportunistically drop anything already expired.
      const now = Date.now();
      for (const [key, value] of Object.entries(state.accessTokens)) {
        if (value.expiresAt < now) delete state.accessTokens[key];
      }
      for (const [key, value] of Object.entries(state.refreshTokens)) {
        if (value.expiresAt < now) delete state.refreshTokens[key];
      }
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  private consentPage(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    error: string | null,
  ): string {
    const hidden = (name: string, value: string | undefined) =>
      value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to CalTrack food logging</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.5; }
  h1 { font-size: 1.25rem; margin-bottom: .25rem; }
  p { color: #666; margin-top: 0; }
  label { display: block; font-weight: 600; margin: 1.5rem 0 .35rem; }
  input[type=password] { width: 100%; padding: .6rem .7rem; font-size: 1rem; border: 1px solid #999; border-radius: .4rem; box-sizing: border-box; }
  button { margin-top: 1rem; width: 100%; padding: .65rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: .4rem; background: #b5540b; color: #fff; cursor: pointer; }
  .error { background: #fdecea; color: #8a1c12; padding: .6rem .75rem; border-radius: .4rem; margin-top: 1rem; }
  .client { font-size: .85rem; color: #777; margin-top: 1.5rem; border-top: 1px solid #ddd; padding-top: .75rem; }
</style></head><body>
<h1>Connect to your food diary</h1>
<p>This grants access to log food into your kaloricketabulky.cz account.</p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="POST">
  ${hidden('client_id', client.client_id)}
  ${hidden('redirect_uri', params.redirectUri)}
  ${hidden('code_challenge', params.codeChallenge)}
  ${hidden('code_challenge_method', 'S256')}
  ${hidden('state', params.state)}
  ${hidden('scope', (params.scopes ?? [MCP_SCOPE]).join(' '))}
  ${hidden('resource', params.resource?.href)}
  ${hidden('response_type', 'code')}
  <label for="password">Access password</label>
  <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
  <button type="submit">Authorize</button>
</form>
<div class="client">Requested by <strong>${escapeHtml(client.client_name ?? client.client_id)}</strong></div>
</body></html>`;
  }
}
