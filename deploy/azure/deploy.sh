#!/usr/bin/env bash
# Deploys kt-mcp to Azure Container Apps. Idempotent: rerun it to ship a new
# build of the current checkout.
#
#   az login
#   ./deploy/azure/deploy.sh
#
# KT_EMAIL, KT_PASSWORD and MCP_AUTH_PASSWORD come from the environment or from
# .env in the repository root. They reach Azure through main.bicepparam, never
# on a command line. Optional overrides:
#
#   AZURE_RESOURCE_GROUP  resource group to deploy into   (default kt-mcp)
#   AZURE_LOCATION        region                          (default westeurope)
#   AZURE_APP_NAME        Container App name              (default kt-mcp)
#   AZURE_PUBLIC_URL      custom domain, once it is bound (default: the app's own hostname)
#
# AZURE_PUBLIC_URL is deliberately separate from PUBLIC_URL, which in .env
# belongs to the Cloudflare tunnel deployment.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [[ -f "$root/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$root/.env"
  set +a
fi

for name in KT_EMAIL KT_PASSWORD MCP_AUTH_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing $name: export it or add it to $root/.env" >&2
    exit 1
  fi
done
export KT_EMAIL KT_PASSWORD MCP_AUTH_PASSWORD

resource_group="${AZURE_RESOURCE_GROUP:-kt-mcp}"
location="${AZURE_LOCATION:-westeurope}"
export AZURE_APP_NAME="${AZURE_APP_NAME:-kt-mcp}"
export AZURE_PUBLIC_URL="${AZURE_PUBLIC_URL:-}"

tag="$(git -C "$root" rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%Y%m%d%H%M%S)"

echo "==> Resource group $resource_group ($location)"
az group create --name "$resource_group" --location "$location" --output none

# Pass 1: everything except the app, so the registry exists to build into.
echo "==> Infrastructure"
export IMAGE_TAG=""
registry=$(az deployment group create \
  --resource-group "$resource_group" \
  --name kt-mcp-infra \
  --parameters "$here/main.bicepparam" \
  --query properties.outputs.registryName.value \
  --output tsv)

echo "==> Building kt-mcp:$tag in $registry"
az acr build --registry "$registry" --image "kt-mcp:$tag" "$root"

# Pass 2: the app, pulling the image just built.
echo "==> Container App"
export IMAGE_TAG="$tag"
public_url=$(az deployment group create \
  --resource-group "$resource_group" \
  --name kt-mcp-app \
  --parameters "$here/main.bicepparam" \
  --query properties.outputs.publicUrl.value \
  --output tsv)

# The deployment returns once the revision is provisioned, which can be a
# little before the container answers.
echo "==> Waiting for $public_url/healthz"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 10 "$public_url/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

"$root/scripts/verify-deployment.sh" "$public_url"
