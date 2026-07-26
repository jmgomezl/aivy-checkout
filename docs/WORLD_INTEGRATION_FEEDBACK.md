# World ID Integration — Testing Documentation (Aivy Checkout)

Beta-track deliverable: developer + user feedback for Selfie Check / Identity
Check. Living document — venue sections filled during the hackathon weekend.

## How Aivy Checkout uses World (meaningful use, not login)

**Assurance tier = economic terms.** A user's World ID verification level sets
the maximum escrow the platform will hold for them:

| Tier | Credential | Escrow cap | Status |
|---|---|---|---|
| DEVICE | World App, no Orb | 2 ℏ | live |
| SELFIE | Selfie Check (beta) | 10 ℏ | flag-gated, opens at venue |
| ORB | Proof of Human | 100 ℏ | live — in-app step-up |

Hitting the cap triggers a **step-up flow** (block → explain → re-verify at a
higher level → unlocked). Selfie Check is the middle rung that makes the
platform usable by *anyone on Earth* — no Orb access required — at
proportionate risk. The nullifier additionally provides sybil resistance
(one human = one active checkout) and is the identity key that wallet linking
and receipts hang off.

## Developer feedback (real, from integration — pre-venue)

1. **Portal: Incognito Actions UI is gone.** The "World ID" tab on
   developer.worldcoin.org only offers the World ID 4.0 upgrade. Creating an
   action for an IDKit-v2 app required discovering
   `POST /api/v2/create-action/{app_id}` with a team API key — undocumented
   friction, cost ~1h. `max_verifications: 0` for unlimited re-verification is
   also non-obvious.
2. **IDKit v2 vs v4 is a hard fork.** v4 (npm latest) changes the entire
   surface (presets, `rp_context`, `IDKitRequestWidget`) and can't coexist with
   v2 in one bundle (same package name). Apps on the stable v2/`/v2/verify`
   flow must pin `@worldcoin/idkit@2`. A migration note in the docs would save
   every team this discovery.
3. **Selfie Check requires v4 + backend-signed `rp_context` + partner
   approval** — i.e. a full 4.0 migration, not an incremental add to a v2 app.
   Fine for the beta, but the docs don't say this up front.
4. **What worked well:** `/v2/verify` server-side verification is clean and
   fast; the v2 IDKitWidget UX (QR/deep-link) needed zero custom code;
   per-app nullifiers behaved exactly as documented.

## Status update (pre-venue): World ID 4.0 is LIVE in production

v4 migration completed and deployed ahead of the weekend: backend-signed
`rp_context` (signRequest), `IDKitRequestWidget` with device/orb/selfie
presets (`proofOfHuman` for orb-tier step-up, `selfieCheckLegacy` for the
beta), verification via `POST /api/v4/verify/{rp_id}`, and
`SELFIE_CHECK_ENABLED=1`. Tier derivation reads only World-verified
credential identifiers (`results[].identifier` and equivalents) — the
client-supplied hint is deliberately ignored for access control.
**Remaining risk:** confirming the exact identifier strings the live v4
verify response uses for each credential (parsed defensively until then).

## Live at the venue: Selfie Check END-TO-END confirmed (with one naming trap)

Ran the real flow on a phone inside the Telegram Mini App (2026-07-26,
~03:00): device-tier sign-in → 10 ℏ escrow rejected by our tier gate →
Selfie Check step-up → World App face capture → proof verified at
`POST /api/v4/verify/{rp_id}`. **It works.** Two findings for the beta team:

5. **The Selfie Check credential identifier is `face`, not `selfie`.** The
   idkit preset is named `selfieCheckLegacy` and all product copy says
   "Selfie Check", but the verified proof comes back with
   `credential=face`. Our tier mapper matched only `selfie`, so a PASSED
   Selfie Check silently landed at device tier and the gate stayed shut —
   cost a live debugging session at 3 AM. A documented list of the exact
   identifier strings each preset yields would have prevented it entirely
   (this is the "remaining risk" above, realized).
6. **Orb-verified testers can't see step-up flows naturally.** An
   Orb-verified human's first proof already carries the top credential, so
   any assurance-laddered app has to build a "clamp me down" demo affordance
   (we did) to exercise Selfie Check at all. A dev-portal toggle to present
   a chosen credential level at max would make beta-testing Selfie Check far
   easier for exactly the population most likely to test it: Orb-verified
   developers.

## Venue TODO (fill during weekend)

- [ ] Confirm live v4 verify response shape + credential identifier strings
      (first real Selfie Check proof); tighten the defensive parser
- [ ] Dev feedback: rp_context signing DX, sandbox behavior, error surfaces
- [ ] User feedback: N users through selfie flow — comprehension of the tier
      step-up ("why am I being asked for a selfie?"), camera-flow friction,
      drop-off point, time-to-complete
- [ ] POH vs Selfie cohorts: compare verification success rate + willingness
      to proceed to a 10 ℏ escrow
- [ ] Sybil score (when enabled): candidate input for cap sizing per tier
- [ ] Sentiment: would we keep Selfie Check? (hypothesis: yes — it is the only
      tier that makes the platform globally accessible without hardware)

## Why this design minimizes data

The app never sees biometrics or identity attributes — only the credential
LEVEL (device/selfie/orb) and the anonymous nullifier. Caps are enforced on
the level alone. If Identity Check is added (e.g. jurisdiction for
insurance-grade inspections), the receipt would store the *attestation
result*, never the underlying document data.
