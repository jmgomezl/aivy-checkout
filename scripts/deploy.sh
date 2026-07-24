#!/usr/bin/env bash
# Deploy Aivy Checkout to the VPS (same box as oculusvault/aivylabs).
# Frontend -> /var/www/aivy-checkout ; backend bundle -> /opt/aivy-checkout.
set -euo pipefail
HOST="${DEPLOY_HOST:-oculusvault-vps}"
cd "$(dirname "$0")/.."

echo "== build frontend =="
(cd webapp && npm run build)

echo "== bundle backend =="
(cd offchain && npx esbuild api-server.ts --bundle --platform=node --format=esm --target=node20 \
  --external:@0glabs/0g-ts-sdk --external:@anthropic-ai/sdk --external:@hashgraph/sdk \
  --outfile=/tmp/aivy-deploy/offchain/server.mjs \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);")
mkdir -p /tmp/aivy-deploy/out/CheckoutEscrow.sol
cp out/CheckoutEscrow.sol/CheckoutEscrow.json /tmp/aivy-deploy/out/CheckoutEscrow.sol/

echo "== ship =="
rsync -az /tmp/aivy-deploy/offchain /tmp/aivy-deploy/out "$HOST":/opt/aivy-checkout/
rsync -az --delete webapp/dist/ "$HOST":/var/www/aivy-checkout/

echo "== restart =="
ssh "$HOST" 'pm2 restart aivy-checkout-api && sleep 3 && curl -s http://127.0.0.1:8791/api/health && echo'
