#!/usr/bin/env bash
# Verifies a deployed kt-mcp is reachable and correctly configured, before you
# add it as a connector in Claude. Read-only: logs in to nothing, writes nothing.
#
#   ./scripts/verify-deployment.sh https://kt-mcp.example.com
set -uo pipefail

BASE="${1:-}"
if [[ -z "$BASE" ]]; then
  echo "usage: $0 https://<your-host>" >&2
  exit 2
fi
BASE="${BASE%/}"
[[ "$BASE" == https://* ]] || { echo "FAIL  URL must be https:// — Claude and OAuth both require TLS" >&2; exit 1; }

fails=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fails=$((fails + 1)); }

echo "Verifying $BASE"

# 1. Reachable over TLS from the public internet, which is what Claude needs.
health=$(curl -fsS --max-time 15 "$BASE/healthz" 2>/dev/null)
if [[ -z "$health" ]]; then
  fail "GET /healthz — not reachable. Check (a) the tunnel's public hostname route exists in Cloudflare and points at http://localhost:80, and (b) 'docker ps' shows kt-mcp, kt-mcp-nginx and kt-mcp-tunnel up"
  echo; echo "$fails check(s) failed."; exit 1
fi
pass "GET /healthz reachable over TLS"

# 2. PUBLIC_URL must match the hostname actually being served, or OAuth
#    discovery advertises a URL Claude cannot reach.
advertised=$(printf '%s' "$health" | sed -n 's/.*"endpoint":"\([^"]*\)".*/\1/p')
if [[ "$advertised" == "$BASE/mcp" ]]; then
  pass "PUBLIC_URL matches this hostname ($advertised)"
else
  fail "PUBLIC_URL mismatch: server advertises '$advertised' but you reached '$BASE'. Set PUBLIC_URL=$BASE and redeploy"
fi

# 3. Discovery documents Claude fetches during the connector handshake.
for path in "/.well-known/oauth-protected-resource/mcp" "/.well-known/oauth-authorization-server"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE$path")
  [[ "$code" == "200" ]] && pass "GET $path → 200" || fail "GET $path → $code (expected 200)"
done

# 4. The MCP endpoint must challenge unauthenticated callers, and the challenge
#    must point back at the resource metadata or Claude cannot start OAuth.
headers=$(curl -s -D - -o /dev/null --max-time 15 -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
if grep -qi '^HTTP/[0-9.]* 401' <<<"$headers"; then
  pass "POST /mcp without a token → 401"
else
  fail "POST /mcp without a token did not return 401 — the endpoint may be unprotected"
fi
if grep -qi 'www-authenticate:.*resource_metadata=' <<<"$headers"; then
  pass "401 carries a resource_metadata challenge"
else
  fail "401 is missing the resource_metadata challenge — Claude will not discover the auth server"
fi

echo
if (( fails == 0 )); then
  echo "All checks passed. Add this as a custom connector in Claude:"
  echo "  $BASE/mcp"
else
  echo "$fails check(s) failed."
  exit 1
fi
