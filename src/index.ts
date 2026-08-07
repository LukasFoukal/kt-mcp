/**
 * Entrypoint: an Express app serving the MCP endpoint plus the OAuth 2.1
 * authorization-server endpoints the Claude connector flow needs.
 *
 *   POST /mcp                                   the MCP endpoint (bearer-protected)
 *   /.well-known/oauth-protected-resource       RFC 9728 discovery
 *   /.well-known/oauth-authorization-server     RFC 8414 discovery
 *   /authorize /token /register /revoke         OAuth endpoints (from the SDK)
 *   GET /healthz                                liveness, unauthenticated
 */

import express from 'express';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './config.js';
import { KtClient } from './kt/client.js';
import { registerTools } from './mcp/tools.js';
import { MCP_SCOPE, SingleUserOAuthProvider } from './auth/provider.js';

const config = loadConfig();
const mcpEndpoint = new URL('/mcp', config.publicUrl);

const kt = new KtClient({ email: config.ktEmail, password: config.ktPassword });
const provider = new SingleUserOAuthProvider(config.mcpAuthPassword, join(config.stateDir, 'oauth-state.json'));

const app = express();
app.disable('x-powered-by');
// Trust exactly one hop — our own nginx — and no further. `true` would trust
// any X-Forwarded-For the caller sends, letting an attacker mint a fresh
// rate-limit bucket per request and defeat brute-force protection on
// /authorize. nginx overwrites that header with Cloudflare's verified client
// IP, so this resolves to the real caller.
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

/**
 * The MCP spec requires Origin validation to defend against DNS rebinding.
 * Browsers set Origin; Claude's server-side fetches do not, so only reject an
 * Origin that is present and foreign.
 */
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin !== undefined && origin !== config.publicUrl.origin) {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Forbidden origin' } });
    return;
  }
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', endpoint: mcpEndpoint.href });
});

// OAuth authorization-server + protected-resource metadata and endpoints.
// Must be mounted at the application root.
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.publicUrl,
    resourceServerUrl: mcpEndpoint,
    resourceName: 'CalTrack food logging',
    scopesSupported: [MCP_SCOPE],
  }),
);

const requireAuth = requireBearerAuth({
  verifier: provider,
  requiredScopes: [MCP_SCOPE],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpEndpoint),
});

/**
 * One MCP server and transport per request.
 *
 * The 2026-07-28 revision of Streamable HTTP removed protocol-level sessions,
 * so each POST is self-contained — statelessness is the intended shape here,
 * and it means a redeploy can never strand a half-open session.
 */
app.post('/mcp', requireAuth, async (req, res) => {
  const server = new McpServer(
    { name: 'kaloricketabulky', version: '0.1.0' },
    {
      instructions:
        'Logs food into the user\'s kaloricketabulky.cz diary. The food database is Czech: search with Czech terms for the best matches. ' +
        'When the user gives a count rather than a weight ("3 eggs"), call get_food_portions and log a natural portion unit instead of estimating grams.',
    },
  );
  registerTools(server, kt);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' } });
    }
  }
});

// Pre-2026-07-28 clients open a GET stream and DELETE sessions; this revision
// has neither.
app.all('/mcp', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' } });
});

app.listen(config.port, () => {
  console.log(`kt-mcp listening on :${config.port}`);
  console.log(`MCP endpoint (public): ${mcpEndpoint.href}`);
});
