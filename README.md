# Aivy Checkout

**AI-verified rental checkout receipts that release or block a security deposit.**

A tenant wants their deposit back. The host defines an itemized checklist (keys
returned, table undamaged, router present). The tenant submits fresh photo
evidence per item; each item carries a **per-item liveness nonce** so old/reused
photos fail. An AI verifier signs an **itemized verdict**. If every required item
passes, the Hedera escrow releases the deposit to the tenant; if items fail or the
deadline passes, the host can resolve. Receipts are sealed on HCS; evidence blobs
live on 0G Storage.

Sponsors: **Hedera** (escrow + HBAR + HCS receipts), **0G** (evidence storage +
optional TEE-signed inference), **World ID** (proof-of-personhood; a fraudulent
tenant is slashed/banned within Aivy — simulated for the demo).

---

## Status — Step 1 (risk-first spike) is DONE and GREEN ✅

The whole architecture rests on one question: *can a verdict signed off-chain be
verified on Hedera's EVM?* Both halves are now proven locally:

| Proof | What it shows | Run |
|---|---|---|
| `test/ItemVerdictVerifier.t.sol` (5/5) | EVM `ecrecover` verifies a signed verdict; rejects tampered verdict / swapped nonce / wrong signer; supports relayer→TEE key swap | `forge test -vv` |
| `offchain/parity-check.ts` | A verdict signed in TypeScript recovers to the same signer — relayer output matches the contract | `cd offchain && npm i && npm run parity` |

**Conclusion:** ship **relayer-signed** verdicts (baseline). If `offchain/probe-0g.ts`
shows 0G Compute emits a stable secp256k1 signature, `setAuthorizedSigner(enclave)`
and you're TEE-signed — *same contract, zero downstream change.*

### Tripwire
If the real 0G TEE does not yield an on-chain-verifiable secp256k1 signature
within the first 2 hours, keep relayer-signed and frame TEE as roadmap. Do not let
it block the escrow build.

---

## The signed payload (single source of truth)

`ItemVerdict` is mirrored byte-for-byte in `src/ItemVerdictVerifier.sol` and
`offchain/payload.ts`. Change one, change both.

```
struct ItemVerdict {
  uint256 checkoutId;
  bytes32 itemId;     // keccak256(item name)
  bool    verdict;    // true = PASS
  bytes32 imageHash;  // keccak256 of the 0G Storage blob
  bytes32 nonceHash;  // keccak256 of the per-item liveness nonce
  uint256 deadline;   // unix; session time-box
}
```

Digest = `personal_sign( keccak256(abi.encode(fields)) )`, matching ethers
`wallet.signMessage(getBytes(structHash))`.

---

## Layout

```
aivy-checkout/
  src/ItemVerdictVerifier.sol     Step 1 spike — the proven signature core (reuse this digest scheme)
  test/ItemVerdictVerifier.t.sol  5 passing tests incl. tamper/nonce/signer/keyswap
  offchain/
    payload.ts        shared ItemVerdict schema + signer (parity source of truth)
    parity-check.ts   TS-signs -> recovers; proves relayer output verifies on-chain
    probe-0g.ts       decides TEE-signed (Outcome A) vs relayer-signed (Outcome B)
    package.json
  foundry.toml
```

## Next stages (not yet built)
- **Stage 2 (hardest):** `CheckoutEscrow` contract (create → deposit → per-item
  verify → all-pass release / timeout resolve) + Node relayer (verifier signer +
  event→HCS logger). Must reuse the proven `ItemVerdict` digest scheme unchanged.
- **Stage 3:** 0G Storage upload + Aivy vision agent prompt.
- **Stage 4:** Telegram Mini App (OculusVault) — World ID auth, checklist, camera.

## Toolchain
Foundry (`forge`), Node 20+, npm. Deploy target: Hedera testnet EVM via a
JSON-RPC relay (set `HEDERA_RPC_URL`, e.g. `https://testnet.hashio.io/api`).
Native HBAR escrow — **no HTS**.
