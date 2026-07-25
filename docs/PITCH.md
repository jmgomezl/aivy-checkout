# AIVY/INSPECT — Pitch Deck & Demo Script
### ETHGlobal Lisboa · Hedera × World × 0G

---

## The arc (one sentence)
We mined thousands of real complaints, found four industries bleeding money
because nobody can prove the physical state of anything at a handover — and
built one engine that turns a phone photo into a cryptographic receipt that
moves real money.

---

## SLIDE 1 — Cold open (0:00–0:20)
**Visual:** one screenshot: the r/Landlord thread — dueling photos over a $200
cleaning fee.

> "Every deposit dispute on Earth looks like this: two people, two photos,
> zero proof. The landlord says damaged. The tenant says lies. Nobody can
> verify **who** took the photo, **when**, **where**, or whether it's even real.
> In the GenAI era, a photo is no longer evidence."

## SLIDE 2 — The research (0:20–0:45)
**Visual:** 4 quotes with upvote counts (from our painminer harvest):
- r/Landlord [993] — the $200 cleaning-fee photo war
- r/FedEx [762] — "marked delivered", courier took it back
- r/Contractor [423] — "always take before pictures"
- r/smallbusiness [10,639] — "best site to BUY Google reviews?"

> "We didn't guess this problem. We mined complaint forums. Property
> handovers, deliveries, contractor work, retail audits — four industries,
> one missing primitive: **verifiable physical evidence**. And the loudest
> thread of all? People openly buying fake reviews. Trust in the physical
> world is already a market — currently supplied by fraud."

## SLIDE 3 — The primitive (0:45–1:10)
**Visual:** the evidentiary tuple, stacked:

| Proof | Mechanism |
|---|---|
| WHO — a unique live human | World ID (device / **Selfie Check** / Orb) |
| THAT IT'S NOW — not a stock photo, not AI | physical liveness challenge, committed on-chain **before** capture |
| WHERE | geo-lock, GPS sealed per capture |
| WHEN | time-lock, on-chain deadline |
| WHAT | AI vision verdict, signed, verified by the contract via ecrecover |
| FOREVER | evidence on 0G Storage · receipt sealed to Hedera Consensus |

> "A stored or generated image cannot satisfy a challenge that didn't exist
> until the moment of capture. That's the trick — and every layer is
> independently verifiable by anyone, forever."

## SLIDE 4 — LIVE DEMO (1:10–3:10) — see script below

## SLIDE 5 — The platform (3:10–3:35)
**Visual:** hub screenshot — six use-case cards + BUILD YOUR OWN.

> "The escrow contract never knew it was about apartments. Rental checkout,
> vehicle return, delivery handover, expense receipts, shelf audits — same
> engine. And businesses define their own: name the items, the AI criteria,
> the physical challenge — escrow, verdicts and sealed receipts come free.
> Your World ID assurance level literally sets your economic limits: Selfie
> Check makes this usable by anyone on Earth, no Orb required."

## SLIDE 6 — Close (3:35–4:00)
**Visual:** the paper receipt, full screen.

> "Everything you watched is live on Hedera testnet right now:
> ecrecover-verified verdicts, evidence on 0G with public download links,
> receipts sealed to HCS topic 0.0.9736741. AI judges the evidence. The chain
> moves the money. You keep the receipt. **Aivy Inspect — proof for anything
> you can photograph.**"

---

## THE 4-MINUTE DEMO SCRIPT (slide 4, rehearse this)

**Props on stage:** phone · the yellow plush toy · the green joystick lamp
(pre-set: wallet linked, so no typing on stage).

| t | Action | Say |
|---|---|---|
| 0:00 | Open checkout.aivylabs.xyz on phone (mirrored) | "Live site, Hedera testnet, no mocks." |
| 0:10 | Tap VERIFY WITH WORLD ID → scan | "First: prove I'm one unique human. No documents, no doxxing — a nullifier. One human, one checkout." |
| 0:30 | Hub → RENTAL CHECKOUT | "The platform has six verticals — we'll do the flagship. My 2 ℏ deposit is already escrowed in a smart contract." |
| 0:40 | Show item 1 challenge | "The contract just committed a challenge: *put this yellow toy on the chair*. This toy exists in no stock photo and no AI training set. An old photo cannot contain it." |
| 0:50 | Place toy, shoot, submit | "Watch the pipeline: hashed → 0G Storage → GPT vision judges the item AND the challenge → verdict signed → the contract verifies that signature with ecrecover." |
| 1:15 | PASS stamps in | "One item sealed, on-chain, with a public evidence link." |
| 1:25 | Item 2: lamp by laptop, shoot | "Different challenge, same physics: the green lamp is my proof of *now*." |
| 1:50 | **THE REJECTION** — pre-staged damaged-item photo (or shoot the wrong object) | "Now let's cheat. Damaged item." → FAIL stamp → "The AI refused it. **The deposit stays locked.** No signature, no money. This is the moment that doesn't exist anywhere else." |
| 2:20 | Redo honestly → last PASS → **receipt prints** | *Pause. Let the paper print animation land.* |
| 2:35 | Scroll the receipt slowly | "Timestamp. My photos. The 0G root — click it, that's the actual evidence blob, publicly downloadable. The verifier's signature. Every transaction on Hashscan. Sealed to Hedera Consensus, sequence number and all. The deposit paid my wallet the instant the last verdict cleared." |
| 3:00 | Flip to OculusVault: balance +2 ℏ | "Real money, in my real wallet, because a machine verified physical reality." |

**Backup plan:** if venue wifi dies, the local stack runs the identical flow
on anvil (`npm run api` + preview) — rehearse once offline too.

---

## Q&A CRIB SHEET (the six attacks)

1. **"GPT can be fooled / prompt-injected via the photo."** Adversarial
   verifier, fail-closed: uncertainty = FAIL, API error = FAIL. And the AI
   never moves money — it *signs*, the contract *verifies*. Wrong-but-signed
   verdicts are bounded by the deposit; the roadmap answer is the 0G TEE
   (contract already supports hot-swapping the verifier key to an enclave —
   `setVerifier`, tested).
2. **"EXIF/GPS can be forged."** We never read EXIF. The challenge is
   committed on-chain before capture; geo comes from the live session and is
   sealed into the signed receipt, not trusted from the file.
3. **"What stops photographing only the good side?"** Itemized receipts —
   hosts define per-item angles/checks. We attest *per named item*, never
   "the whole apartment is fine."
4. **"Why World ID if there's already a deposit?"** The deposit bounds one
   checkout; the nullifier bounds the *person* — ban evasion, one-active-case
   per human, and assurance tiers set escrow caps (economic terms, not login).
5. **"The relayer is trusted."** Yes — baseline. It's one `setVerifier` call
   away from a 0G TEE enclave key (tested in the suite). Trust seam named,
   exit built.
6. **"Is anything mocked?"** World ID live (v2, portal-verified). Hedera
   live (escrow 0x3516…E269, HCS 0.0.9736741). 0G live (public roots).
   Vision: real GPT. The only sim left is Selfie Check — flag-armed for the
   beta this weekend.

---

## SUBMISSION BLURB (paste-ready)

**Aivy Inspect — verifiable inspection receipts for the physical world.**
AI can analyze evidence but can't walk to the apartment. Aivy turns any
handover dispute — rental deposits, vehicle returns, deliveries, expense
receipts, shelf audits — into a cryptographic receipt: a verified unique
human (World ID, with Selfie Check assurance tiers that set escrow caps)
captures evidence against an on-chain-committed physical challenge; GPT
vision judges item condition and challenge compliance and signs an itemized
verdict; a Hedera escrow verifies the signature with ecrecover and releases
the deposit the instant the last item passes; evidence lives on 0G Storage
with publicly downloadable roots and the full receipt is sealed to Hedera
Consensus. Optional geo-lock and time-lock seal WHERE and WHEN. Businesses
compose their own inspections — the escrow, liveness, AI verdicts and
receipts come free. Live: https://checkout.aivylabs.xyz · Contract:
hashscan.io/testnet/contract/0x3516a9d9bb6cC6D1B565Ea228137DCB7FdddE269 ·
Receipts: hashscan.io/testnet/topic/0.0.9736741
