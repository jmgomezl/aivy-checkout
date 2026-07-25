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
| Chain | Hedera testnet — escrow [`0x3516a9d9bb6cC6D1B565Ea228137DCB7FdddE269`](https://hashscan.io/testnet/contract/0x3516a9d9bb6cC6D1B565Ea228137DCB7FdddE269) |
| HCS receipts | topic [`0.0.9736741`](https://hashscan.io/testnet/topic/0.0.9736741) |
| Proof of personhood | World ID `app_952df7edf32b602c03c445e6732ea04a`, action `aivy-checkout` |

Every verdict on that site is a real signed transaction on Hedera testnet, and every
receipt links to HashScan.

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

**Hedera** — native HBAR escrow (no HTS). The itemized state machine, the `ecrecover`
verdict check, and the auto-release all live in `CheckoutEscrow.sol`. Receipts are
sealed to HCS by the relayer, because the EVM cannot write HCS directly.

**0G** — evidence blobs upload to 0G Storage and receipts link to the indexer by root.
Uploads are budgeted rather than awaited (see *Engineering notes*).

**World ID** — one human, one live checkout. The nullifier is the sybil key: no
documents, no wallet-per-person assumption. Device-level verification, so any World
App user can pass.

## Templates

One escrow and one verdict engine, many checklists — anything two parties dispute at a
handover.

| Template | Who pays for it |
|---|---|
| Rental Checkout *(flagship)* | hosts & property managers |
| Vehicle Return | rental fleets & insurers |
| Scooter Return | micromobility fleets & insurers |
| Delivery Handover | merchants & 3PLs |
| Retail Shelf Audit | CPG brands & distributors |

Plus a custom builder: define your own items and liveness challenges in the app.

## Tests

```bash
forge test          # 17 passed, 0 failed
```

Covering the happy path, FAIL-keeps-funds-locked, timeout→host, replay, wrong signer,
uncommitted nonce, wrong deposit, and the relayer→TEE signer swap.

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
- **Hedera payouts need an existing account.** A transfer to an address with no Hedera
  account reverts and would trap the deposit, so payout targets are checked against
  the mirror node first.

## Layout

```
aivy-checkout/
  src/CheckoutEscrow.sol          itemized escrow state machine + auto-release
  src/ItemVerdictVerifier.sol     the ecrecover verdict core
  test/                           17 forge tests
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
`WORLD_APP_ID`/`WORLD_ACTION`, `ZEROG_RPC_URL`/`ZEROG_INDEXER_URL`/`ZEROG_PRIVATE_KEY`,
`ZEROG_TIMEOUT_MS`.

Unset `WORLD_APP_ID` and the app runs in simulator mode; unset the 0G or vision creds
and each falls back loudly rather than silently. The contract flow is identical either
way.

## Toolchain

Foundry (`forge`), Node 20+, npm. Deploy target: Hedera testnet EVM via a JSON-RPC
relay (`https://testnet.hashio.io/api`). Native HBAR escrow — **no HTS**.
