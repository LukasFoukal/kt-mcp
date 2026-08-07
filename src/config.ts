/**
 * Configuration is entirely environment-driven and validated at boot, so a
 * missing secret fails the container immediately rather than at first use.
 */

export interface Config {
  ktEmail: string;
  ktPassword: string;
  mcpAuthPassword: string;
  publicUrl: URL;
  port: number;
  stateDir: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const publicUrl = new URL(required('PUBLIC_URL'));
  if (publicUrl.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must be an https:// URL — OAuth and MCP both require TLS');
  }
  // The OAuth issuer must have no query or fragment, and we compare it against
  // the RFC 8707 resource identifier, so normalise away a trailing slash.
  publicUrl.search = '';
  publicUrl.hash = '';
  if (publicUrl.pathname === '/') publicUrl.pathname = '';

  const mcpAuthPassword = required('MCP_AUTH_PASSWORD');
  if (mcpAuthPassword.length < 12) {
    throw new Error('MCP_AUTH_PASSWORD must be at least 12 characters — this guards a public endpoint');
  }

  const port = Number(process.env['PORT'] ?? 8092);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${process.env['PORT']}"`);
  }

  return {
    ktEmail: required('KT_EMAIL'),
    ktPassword: required('KT_PASSWORD'),
    mcpAuthPassword,
    publicUrl,
    port,
    // Docker sets /data explicitly; the bare-metal default must be writable
    // by an unprivileged local dev run.
    stateDir: process.env['STATE_DIR'] ?? './data',
  };
}
