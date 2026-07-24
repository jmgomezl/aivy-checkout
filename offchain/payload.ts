/**
 * Shared ItemVerdict schema — the single source of truth for what the AI
 * verifier signs. This MUST stay byte-identical to the struct + `digest()` in
 * src/ItemVerdictVerifier.sol, or signatures will not recover on-chain.
 *
 * Encoding parity (matches the Solidity `digest()`):
 *   structHash = keccak256(abi.encode(fields...))
 *   digest     = personal_sign( structHash )   // "\x19Ethereum Signed Message:\n32"
 *
 * ethers v6 `wallet.signMessage(getBytes(structHash))` applies that exact
 * prefix, so the contract's `ecrecover(digest, ...)` recovers the signer.
 */
import { AbiCoder, keccak256, getBytes, Wallet } from "ethers";

export interface ItemVerdict {
  checkoutId: bigint;
  itemId: string; // bytes32, e.g. itemIdOf("espresso_machine")
  verdict: boolean;
  imageHash: string; // bytes32 keccak of the 0G Storage blob
  nonceHash: string; // bytes32 keccak of the per-item liveness nonce
  deadline: bigint; // unix seconds
}

const coder = AbiCoder.defaultAbiCoder();

export function itemIdOf(name: string): string {
  return keccak256(Buffer.from(name));
}

/** structHash = keccak256(abi.encode(...)) — mirrors the contract exactly. */
export function structHash(v: ItemVerdict): string {
  return keccak256(
    coder.encode(
      ["uint256", "bytes32", "bool", "bytes32", "bytes32", "uint256"],
      [v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline]
    )
  );
}

/** Sign a verdict the way the relayer (or 0G TEE) must. Returns 65-byte hex. */
export async function signVerdict(signer: Wallet, v: ItemVerdict): Promise<string> {
  // signMessage over the RAW 32 bytes of structHash == contract's digest().
  return signer.signMessage(getBytes(structHash(v)));
}

export function encodeVerdictTuple(v: ItemVerdict) {
  // Order matches the Solidity struct field order for contract calls.
  return [v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline] as const;
}
