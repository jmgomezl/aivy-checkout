# Selfie Check — Venue Activation Runbook (branch: world-selfie-v4)

Everything is pre-built. When World enables beta access at the venue:

## 1. Portal (World booth can help) — ~10 min
- Upgrade the app to World ID 4.0 in the Developer Portal → note the **rp_id**
- Generate the RP **signing key** → `WORLD_RP_SIGNING_KEY` (hex)
- Confirm Selfie Check credential is enabled for the app (beta approval)

## 2. Server env (`/opt/aivy-checkout/.env`) — 2 min
```
WORLD_RP_ID=rp_xxxxx
WORLD_RP_SIGNING_KEY=<hex signing key>
SELFIE_CHECK_ENABLED=1
```

## 3. Deploy the branch — 5 min
```bash
git checkout world-selfie-v4 && ./scripts/deploy.sh
ssh oculusvault-vps 'pm2 restart aivy-checkout-api --update-env'
```

## 4. Verify — 5 min
- /api/health shows `worldRpId` set and `selfieEnabled: true`
- Gate button → v4 widget opens (device preset, legacy proofs allowed)
- Pick Vehicle Return (10 ℏ) on a device-tier account → step-up panel →
  **🤳 SELFIE CHECK** now active → complete selfie → tier chip flips to
  🤳 SELFIE · CAP 10 ℏ → checkout proceeds
- `[api] ✅ v4 verified … credential=selfie_check tier=selfie` in pm2 logs

## 5. VENUE-TODO markers in code
- `api-server.ts` `/api/world/verify-v4`: confirm exact response shape of
  `POST developer.world.org/api/v4/verify/{rp_id}` (nullifier + credential
  field names are parsed defensively — tighten once observed)

## 6. Capture feedback while testing (docs/WORLD_INTEGRATION_FEEDBACK.md)
Time-to-integrate, rp_context DX, sandbox behavior, 5 user runs
(comprehension / camera friction / drop-off), POH vs Selfie observations.

## Rollback
`git checkout main && ./scripts/deploy.sh` — prod v2 flow untouched by this branch.
