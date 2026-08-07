#!/usr/bin/env bash
# Adversarial audit of the deployed server: attempts to reach the tools
# without the passphrase. Read-only — registers throwaway OAuth clients and
# makes failed login attempts, but never logs food or reads the diary.
# Usage: ./scripts/security-audit.sh   (expects the stack running on loopback)
# Point at a deployment. Defaults to the local stack behind nginx.
: "${MCP_HOSTNAME:?set MCP_HOSTNAME to the public hostname of the server}"
: "${MCP_AUTH_PASSWORD:?set MCP_AUTH_PASSWORD so the brute-force check can prove the real one is never guessed}"
B="${MCP_BASE_URL:-http://127.0.0.1}"; HOST="Host: $MCP_HOSTNAME"
pass=0; fail=0
ok(){ printf '  \033[32mBLOCKED\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mLEAK!!!\033[0m  %s\n' "$1"; fail=$((fail+1)); }
mcp(){ curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "${2:-POST}" "$B/mcp" -H "$HOST" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' ${1:+-H "Authorization: Bearer $1"} \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'; }

echo "── Sanity: does an unauthenticated request even reach the MCP server? ──"
code=$(mcp); [ "$code" = 401 ] && ok "reaches kt-mcp and is rejected → 401" || bad "unexpected → $code"

echo; echo "── Attack 1: forged / random bearer tokens ──"
for t in "$(head -c24 /dev/urandom | base64 | tr -d '/+=')" admin null undefined " "; do
  code=$(mcp "$t"); [ "$code" = 401 ] && ok "token '${t:0:10}' → 401" || bad "token '${t:0:10}' → $code"
done

echo; echo "── Attack 2: register a client, then forge tokens at /token ──"
CID=$(curl -s --max-time 10 "$B/register" -H "$HOST" -H 'Content-Type: application/json' \
  -d '{"client_name":"Attacker","redirect_uris":["https://evil.example/cb"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"}' \
  | sed -n 's/.*"client_id":"\([^"]*\)".*/\1/p')
echo "  (DCR is open by design — attacker registered client_id=${CID:0:12}…)"
for c in guess AAAAAAAA "$(head -c24 /dev/urandom | base64 | tr -d '/+=')"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$B/token" -H "$HOST" \
    -d "grant_type=authorization_code&code=$c&code_verifier=xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz&client_id=$CID&redirect_uri=https%3A%2F%2Fevil.example%2Fcb")
  [ "$code" -ge 400 ] && ok "fabricated code '${c:0:8}' → $code" || bad "fabricated code accepted → $code"
done

echo; echo "── Attack 3: brute-force the consent password ──"
CH=$(printf 'x%.0s' {1..43}); codes=0; limited=0
# Deliberately wrong guesses, plus a near-miss derived at runtime from the
# real passphrase (never written to disk) to prove prefix matches are rejected.
for g in "" password admin 123456 "${MCP_AUTH_PASSWORD%????}" "${MCP_AUTH_PASSWORD}x"; do
  out=$(curl -s -D - -o /dev/null --max-time 10 "$B/authorize" -H "$HOST" \
    --data-urlencode "client_id=$CID" --data-urlencode 'redirect_uri=https://evil.example/cb' \
    --data-urlencode 'response_type=code' --data-urlencode "code_challenge=$CH" \
    --data-urlencode 'code_challenge_method=S256' --data-urlencode 'scope=caltrack:log' \
    --data-urlencode "password=$g")
  grep -qi '^location:.*code=' <<<"$out" && codes=$((codes+1))
  grep -qi '^HTTP/[0-9.]* 429' <<<"$out" && limited=$((limited+1))
done
[ "$codes" = 0 ] && ok "6 wrong passwords → 0 authorization codes issued" || bad "$codes wrong password(s) produced a code!"
echo "  (429 rate-limited responses among those 6: $limited)"

echo; echo "── Attack 4: refresh-token grant without authenticating ──"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$B/token" -H "$HOST" \
  -d "grant_type=refresh_token&refresh_token=$(head -c24 /dev/urandom | base64 | tr -d '/+=')&client_id=$CID")
[ "$code" -ge 400 ] && ok "forged refresh_token → $code" || bad "forged refresh_token → $code"

echo; echo "── Attack 5: do public endpoints leak secrets? ──"
for p in /healthz /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server; do
  body=$(curl -s --max-time 10 "$B$p" -H "$HOST")
  if grep -qF -e "$MCP_AUTH_PASSWORD" -e "JSESSIONID" -e "${KT_EMAIL:-__none__}" <<<"$body"; then bad "$p leaks a secret"; else ok "$p exposes no credential"; fi
done

echo; echo "── Attack 6: verb / path tricks to skip the auth middleware ──"
for spec in "GET /mcp" "DELETE /mcp" "PUT /mcp" "POST /mcp/" "POST /MCP" "POST //mcp"; do
  m=${spec% *}; p=${spec#* }
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X "$m" "$B$p" -H "$HOST" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  case "$code" in 401|404|405) ok "$m $p → $code";; *) bad "$m $p → $code";; esac
done

echo; echo "══════════════════════════════════════════════════"
echo "blocked: $pass   leaked: $fail"
