You are picking up a solo ETHGlobal Lisbon build ("Aivy Checkout") at Stage 2 —
the hardest, most complete stage. Step 1 is already built, tested, and GREEN.
Build the full escrow state machine and the Node relayer on top of it. Do not
redesign what is proven. Output complete, compiling, tested code.

## What already exists (build ON this, do not change its signature scheme)

Repo: `aivy-checkout/` (Foundry + a Node `offchain/` workspace).

- `src/ItemVerdictVerifier.sol` — PROVEN. Verifies an off-chain-signed `ItemVerdict`
  via `ecrecover`. 5 Foundry tests pass, including tamper / swapped-nonce /
  wrong-signer rejection and a relayer→TEE key swap.
- `offchain/payload.ts` — the `ItemVerdict` schema + `signVerdict()`, proven to
  recover on-chain by `offchain/parity-check.ts` (passing).

The signed struct and digest — REUSE EXACTLY, byte for byte:

```
struct ItemVerdict { uint256 checkoutId; bytes32 itemId; bool verdict;
                     bytes32 imageHash; bytes32 nonceHash; uint256 deadline; }
digest = keccak256("\x19Ethereum Signed Message:\n32",
                   keccak256(abi.encode(checkoutId,itemId,verdict,imageHash,nonceHash,deadline)))
```

If you alter field order or encoding, the passing parity + tests break. Don't.

## Hard constraints (these are settled — do not relitigate)
- Native **HBAR** escrow. **No HTS**, no token association.
- Signature: **secp256k1 + `ecrecover`** only. No ed25519, no EIP-712 rewrite —
  keep the exact personal_sign digest above.
- **EVM cannot write to HCS.** The contract emits events; the **relayer** logs the
  receipt to HCS via the Hedera SDK after the event. Do not call HCS from Solidity.
- One authorized verifier signer (relayer key baseline; swappable to a 0G TEE key
  later via the same setter pattern already in `ItemVerdictVerifier`).
- Solo dev, hackathon: clarity and passing tests over abstraction. No proxies.

## Deliverable 1 — `src/CheckoutEscrow.sol`

A per-checkout escrow with an itemized verdict state machine.

State / data model:
- `Checkout { address host; address tenant; uint256 deposit; uint64 deadline;
   uint8 requiredItems; uint8 passedItems; Status status; address verifier; }`
- `Status { None, Funded, Released, Resolved }`
- Per checkout: the set of required `itemId`s (host commits their hashes at
  creation), each item's committed `nonceHash`, and each item's PASS/FAIL.

Functions:
- `createCheckout(checkoutId, host, tenant, deadline, bytes32[] itemIds)` — records
  the checklist; sets required count. Host-initiated.
- `commitNonce(checkoutId, itemId, bytes32 nonceHash)` — backend/host commits the
  per-item liveness nonce hash BEFORE capture. Reverts after deadline.
- `deposit(checkoutId)` **payable** — locks HBAR (== agreed deposit). → `Funded`.
- `verifyItemAndRelease(checkoutId, ItemVerdict v, bytes sig)` — the core:
  1. recover signer from `v`+`sig` (reuse the proven digest); require == verifier.
  2. require `v.checkoutId` matches, `v.deadline >= block.timestamp`,
     `v.nonceHash` == the committed nonce for `v.itemId`, item not already passed.
  3. if `v.verdict` true → mark item passed, `passedItems++`; emit `ItemVerified`.
  4. when `passedItems == requiredItems` → transfer full deposit to tenant,
     status `Released`, emit `DepositReleased`.
  A `false` verdict emits `ItemVerified(pass=false)` and does NOT advance.
- `resolveTimeout(checkoutId)` — after deadline, if not `Released`: send deposit to
  **host**, status `Resolved`, emit `CheckoutResolved`. Funds can never lock.
- Views: `getCheckout`, `isItemPassed`, `remainingItems`.

Events: `CheckoutCreated`, `NonceCommitted`, `Deposited`, `ItemVerified`,
`DepositReleased`, `CheckoutResolved`. (The relayer indexes these; a
`DepositReleased`/`CheckoutResolved` triggers the HCS receipt.)

Guards: reentrancy-safe release (checks-effects-interactions; set status before
transfer), only-verifier signature (via recovery, not msg.sender), deadline checks,
no double-pass, deposit amount == expected.

## Deliverable 2 — `test/CheckoutEscrow.t.sol` (Foundry)

Must compile and pass with `forge test`. Cover at minimum:
1. **Happy path:** create → commit 3 nonces → deposit → verify 3 items with valid
   signatures → deposit transferred to tenant, status Released.
2. **Failure path:** one item verified with `verdict=false` (or a tampered/swapped
   nonce that fails recovery/nonce-match) → deposit NOT released; tenant balance
   unchanged.
3. **Timeout path:** deadline passes with items incomplete → `resolveTimeout`
   sends deposit to host.
4. **Reuse/replay:** the same valid item verdict submitted twice does not double
   count; a verdict for the wrong `checkoutId` reverts.
5. **Only-verifier:** a verdict signed by a non-authorized key reverts/returns false.
Use `vm.sign` with a known pk as the verifier, mirroring the existing spike test.

## Deliverable 3 — `offchain/relayer.ts` (Node + ethers v6, TS)

Responsibilities (wire real calls; mock only external creds behind env):
- **Verifier signer service:** given an `ItemVerdict`, sign it with the relayer key
  using the existing `signVerdict()` from `payload.ts` (do not reimplement).
- **Submitter:** call `verifyItemAndRelease` on the deployed `CheckoutEscrow`.
- **Event listener:** subscribe to `DepositReleased` and `CheckoutResolved`.
- **HCS logger:** on those events, submit a compact receipt JSON
  `{ checkoutId, tenant, host, outcome, itemVerdicts[], imageHashes[], txHash, ts }`
  to a Hedera Consensus Service topic via `@hashgraph/sdk`. If HCS creds are absent,
  write the same receipt to `offchain/receipts/*.json` and log clearly that HCS is
  stubbed — never silently skip.
- Config via `.env`: `HEDERA_RPC_URL`, `RELAYER_PRIVATE_KEY`, `ESCROW_ADDRESS`,
  `HCS_TOPIC_ID`, `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`.
Add `offchain/deploy.ts` (forge or ethers) to deploy `CheckoutEscrow` and print the
address, and extend `package.json` scripts (`deploy`, `relayer`).

## Acceptance (must all hold before you stop)
- `forge test` — ALL suites green, including the new lifecycle tests above.
- `CheckoutEscrow` reuses the exact `ItemVerdict` digest; the existing
  `ItemVerdictVerifier` tests and `parity-check.ts` still pass.
- `resolveTimeout` guarantees funds are never permanently locked.
- Relayer runs, signs, submits, and produces a receipt (HCS or file fallback).

## Do NOT
- Do not change the `ItemVerdict` struct or digest.
- Do not add HTS, proxies, or a new signing scheme.
- Do not call HCS from Solidity.
- Do not build the Telegram frontend (that is Stage 4).

Start by reading `src/ItemVerdictVerifier.sol` and `offchain/payload.ts`, then write
`CheckoutEscrow.sol`, then its tests, then the relayer. Report `forge test` output.
