# Aivy Checkout

**Verifiable inspection receipts for the physical world — an AI judges the evidence, the chain moves the money.**

A tenant wants their deposit back. The host defines an itemized checklist. The tenant
submits fresh photo evidence per item, and every item carries a **per-item liveness
nonce** — committed on-chain *before* the photo is taken — so an old or reused photo
fails. An adversarial AI verifier signs an **itemized verdict**. The moment the last
required item passes, the Hedera escrow releases the deposit to the tenant with no
counterparty in the loop. If items fail or the deadline passes, the host resolves.
Receipts are sealed to HCS; evidence blobs go to 0G Storage.

Built at **ETHGlobal Lisboa**.

## Live

| | |
|---|---|
| Web | **https://checkout.aivylabs.xyz** |
| Telegram Mini App | **https://t.me/aivycheckout_bot** |
| Chain | Hedera testnet — escrow [`0x83B55906c6359c3f43Bf95cb8Cdef4455DB68226`](https://hashscan.io/testnet/contract/0x83B55906c6359c3f43Bf95cb8Cdef4455DB68226) |
| HCS receipts | topic [`0.0.9736741`](https://hashscan.io/testnet/topic/0.0.9736741) |
| Proof of personhood | World ID `app_952df7edf32b602c03c445e6732ea04a`, action `aivy-checkout` |

Every verdict on that site is a real signed transaction on Hedera testnet, and every
receipt links to HashScan.

## Deployments

**Hedera testnet** — where the deposit is escrowed and released.

| what | address |
|---|---|
| `CheckoutEscrow` | [`0x83B55906c6359c3f43Bf95cb8Cdef4455DB68226`](https://hashscan.io/testnet/contract/0x83B55906c6359c3f43Bf95cb8Cdef4455DB68226) |
| Relayer / authorized verdict signer | [`0x44f7769bFB6E872f491CcF0B655Bee8c06A640a0`](https://hashscan.io/testnet/account/0x44f7769bFB6E872f491CcF0B655Bee8c06A640a0) |
| HCS receipt topic | [`0.0.9736741`](https://hashscan.io/testnet/topic/0.0.9736741) |

**0G Galileo testnet** (chain 16602) — where evidence is stored and inference is bought.

| what | address |
|---|---|
| Our 0G account (funds the compute ledger and storage) | `0x44f7769bFB6E872f491CcF0B655Bee8c06A640a0` |
| 0G Compute ledger contract | `0xE70830508dAc0A97e6c087c75f402f9Be669E406` |
| 0G Compute inference serving contract | `0xa79F4c8311FF93C06b8CfB403690cc987c93F91E` |
| Inference provider we acknowledged on-chain (`qwen/qwen2.5-omni-7b`) | `0xa48f01287233509FD694a22Bf840225062E67836` |

`CheckoutEscrow` is ours. The 0G ledger and serving contracts are the network's — listed
because our account holds a funded ledger there and each verdict is billed through them.

## Why it isn't just "upload a photo"

Three properties have to hold at once, and each one is enforced somewhere different:

1. **The photo is fresh.** `commitNonce` writes `keccak256(instruction)` on-chain when
   the checkout opens. The verdict is only accepted if its `nonceHash` matches that
   commitment, so evidence for a challenge nobody had published yet cannot be
   pre-baked. Anti-replay lives in the contract, not in the prompt.
2. **The judgement is honest.** The verifier is prompted adversarially — the uploader
   is financially motivated to hide damage — and must satisfy *both* condition and
   liveness, failing when uncertain.
3. **The payout is unilateral.** `verifyItemAndRelease` checks an `ecrecover`
   signature. When the final required item passes, the contract transfers in the same
   call. No host approval step exists to be withheld.

## The signed payload (single source of truth)

`ItemVerdict` is mirrored byte-for-byte in `src/ItemVerdictVerifier.sol` and
`offchain/payload.ts`. Change one, change both — `npm run parity` proves they agree.

```
struct ItemVerdict {
  uint256 checkoutId;
  bytes32 itemId;     // keccak256(item name)
  bool    verdict;    // true = PASS
  bytes32 imageHash;  // keccak256 of the evidence blob
  bytes32 nonceHash;  // keccak256 of the per-item liveness nonce
  uint256 deadline;   // unix; session time-box
}
```

Digest = `personal_sign(keccak256(abi.encode(fields)))`, matching ethers
`wallet.signMessage(getBytes(structHash))`.

## Sponsor integrations

**Hedera** — target prize: **AI & Agentic Payments on Hedera**, specifically
the autonomous escrow pattern. Aivy is an AI settlement agent: it opens an HBAR
escrow on Hedera testnet, commits liveness challenges, accepts verifier-signed
item verdicts, and releases the payment automatically when the signed condition
is satisfied. If evidence fails or the deadline passes, the escrow resolves to
the host. Receipts are sealed to HCS by the relayer, because the EVM cannot
write HCS directly.

How this maps to Hedera's requirements:

| Requirement | Where Aivy satisfies it |
|---|---|
| AI agent or system executes a financial operation on Hedera testnet | `verifyItemAndRelease` releases native HBAR when the AI/verifier-signed condition passes |
| Uses Hedera SDKs directly | `@hashgraph/sdk` submits final receipts to HCS |
| Working autonomous payment flow | create checkout -> deposit HBAR -> commit nonces -> submit evidence -> signed verdict -> auto-release |
| Verifiable audit trail | every final receipt is written to HCS and replayed from the Mirror Node archive |

Not targeted: **No Solidity Allowed** (this project intentionally uses Solidity
for escrow), **Tokenization** (no HTS), **x402** (no pay-per-request flow), and
**Schedule Service** (deadlines are contract-enforced, not scheduled
transactions).

**0G** — two layers.

*Storage* (live): evidence blobs upload to 0G Storage via
`@0gfoundation/0g-storage-ts-sdk` and receipts link to the indexer by root. Uploads are
budgeted rather than awaited (see *Engineering notes*).

*Compute* (live, `ZEROG_COMPUTE=1`): the verdict that releases the deposit runs on 0G
Compute via `@0gfoundation/0g-compute-ts-sdk` — model `qwen/qwen2.5-omni-7b`, billed
through an on-chain ledger, provider acknowledged on-chain. The response signature is
fetched and verified with `broker.inference.processResponse`, and the outcome is written
into the evidence log and sealed to HCS with the rest of the receipt, so which brain
ruled — and whether its signature verified — is checkable on-chain rather than asserted
here.

**What we can and cannot claim, precisely.** The service is registered on-chain with
`verifiability: TeeML`, and its per-response signature verifies. But its attestation
endpoint returns **501 — "attestation report is not available for centralized
providers"**, and the signature payload is tagged `centralized:aliyun`. So the honest
claim is *verified inference on 0G Compute*, not *TEE-sealed inference*. The two other
multimodal TeeML providers on the network (`google/gemma-3-27b-it`,
`openai/gpt-oss-20b`) were unreachable during the hackathon. The code verifies whatever
the provider offers, so the day a real attesting provider is live this becomes TEE-sealed
with no change.

Fail-soft: on any provider error, timeout, rate limit, or unparseable answer the call
returns null and the conventional vision brain decides — and the receipt records which
one did, because a fallback verdict is not a 0G verdict.

`npm run probe:compute` validates the path end to end (ledger, handshake, image request,
signature verification) before it is switched on.

**World ID** — one human, one live checkout. The nullifier is the sybil key: no
documents, no wallet-per-person assumption. Device-level verification, so any World
App user can pass.

## Templates

One escrow and one verdict engine, many checklists — anything two parties dispute at a
handover.

| Template | Who pays for it |
|---|---|
| Rental Checkout *(flagship)* | hosts & property managers |
| Expense Receipt | finance teams & expense platforms |
| Vehicle Return | rental fleets & insurers |
| Scooter Return | micromobility fleets & insurers |
| Delivery Handover | merchants & 3PLs |
| Retail Shelf Audit | CPG brands & distributors |

Plus a custom builder: define your own items and liveness challenges in the app.

Note what Expense Receipt changes: the subject stops being an object's condition and
becomes a document's authenticity. Expense fraud is largely photographing a screen,
claiming the same receipt twice, and editing totals — and a challenge committed
on-chain *before* the photo exists cannot be satisfied by an image that already
existed. Same escrow, same verdict signature, different fraud.

## Tests

```bash
forge test          # 22 passed, 0 failed
```

Covering the happy path, FAIL-keeps-funds-locked, timeout→host, replay, wrong signer,
uncommitted nonce, wrong deposit, the registrar gate, and the relayer→TEE signer swap.
`cd offchain && npm test` runs 30 more over the guards (key resolution, personhood
mode, nonce generation, prompt sanitising).

```bash
anvil &                            # local chain
cd offchain && npm i && npm run e2e   # full loop incl. rejection + timeout paths
npm run parity                     # TS signature recovers to the same signer
```

## Engineering notes

Things that cost real time and are easy to get wrong again:

- **Hedera value units.** Inside Hedera's EVM `msg.value` is tinybar (8 decimals),
  while the JSON-RPC relay takes tx value in weibar (18). The stored deposit must be
  tinybar-scaled or the equality check reverts.
- **Hedera nonces.** The relay rejects future-nonce transactions instead of queueing
  them like geth, so transactions are sent sequentially. Opening a checkout awaits
  `createCheckout` and `deposit`; the nonce commits finish in the background and are
  awaited later, at the first evidence upload.
- **0G finalization is not on the critical path.** A segment can spend a minute in
  "available, but not finalized yet". Since the keccak hash that goes on-chain is the
  same whether the bytes sit on 0G or on disk, the upload gets a budget
  (`ZEROG_TIMEOUT_MS`, default 12s) and then continues in the background.
- **0G SDK.** Use `@0gfoundation/0g-storage-ts-sdk`. The older `@0glabs/0g-ts-sdk`
  (0.3.x) targets a retired flow contract and its submit reverts on Galileo.
- **iPhone photos are HEIC**, which vision APIs reject outright — the verdict never
  runs. Captures are re-encoded to JPEG in a canvas before upload, which also drops a
  4 MB photo to ~600 KB.
- **Liveness challenges must be stageable.** A gesture held against a lit screen reads
  as noise; a placed object reads as a placed object. And item descriptions must
  describe structural damage, not wear — "no scratches" on venue furniture fails
  honestly, forever.
- **`createCheckout` is registrar-gated.** Without it anyone could squat an unused
  `checkoutId`, register themselves as host with a deadline a second away, and take the
  deposit through `resolveTimeout`. The deployer is the first registrar.
- **Hedera payouts need an existing account.** A transfer to an address with no Hedera
  account reverts and would trap the deposit, so payout targets are checked against
  the mirror node first.

## Layout

```
aivy-checkout/
  src/CheckoutEscrow.sol          itemized escrow state machine + auto-release
  src/ItemVerdictVerifier.sol     the ecrecover verdict core
  test/                           22 forge tests
  offchain/
    api-server.ts                 HTTP API: World ID gate, checkouts, evidence
    payload.ts                    shared ItemVerdict schema + signer
    vision-agent.ts               adversarial verifier (OpenAI vision; offline mock)
    storage-0g.ts                 0G Storage with content-addressed local fallback
    relayer.ts                    signs verdicts, submits, seals receipts to HCS
    e2e-demo.ts                   whole loop on a local Anvil chain
  webapp/                         React mini app (IDKit, camera capture, receipt)
  scripts/deploy.sh               build, ship, restart
```

## Configuration

`RPC_URL`, `RELAYER_PRIVATE_KEY`, `ESCROW_ADDRESS`, `PORT`, `CORS_ORIGIN`,
`OPENAI_API_KEY`, `HCS_TOPIC_ID`, `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`,
`WORLD_APP_ID`/`WORLD_ACTION`, `WORLD_RP_ID`/`WORLD_RP_SIGNING_KEY`,
`SELFIE_CHECK_ENABLED`, `ZEROG_RPC_URL`/`ZEROG_INDEXER_URL`/`ZEROG_PRIVATE_KEY`,
`ZEROG_TIMEOUT_MS`/`ZEROG_COMPUTE`.

Unset `WORLD_APP_ID` and the app runs in simulator mode; unset the 0G or vision creds
and each falls back loudly rather than silently. The contract flow is identical either
way.

## License

MIT — see [LICENSE](LICENSE).

## Team

**Juan Manuel Gomez** — Telegram [@jmgomezl](https://t.me/jmgomezl) · GitHub
[@jmgomezl](https://github.com/jmgomezl)

## Toolchain

Foundry (`forge`), Node 20+, npm. Deploy target: Hedera testnet EVM via a JSON-RPC
relay (`https://testnet.hashio.io/api`). Native HBAR escrow — **no HTS**.
