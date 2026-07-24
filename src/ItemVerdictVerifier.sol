// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ItemVerdictVerifier — Step 1 risk spike
/// @notice Proves the load-bearing assumption of Aivy Checkout: that a verdict
///         signed OFF-CHAIN (by the relayer baseline, or the 0G TEE upgrade)
///         can be verified ON-CHAIN on Hedera's EVM via `ecrecover`.
///
///         The signer is deliberately abstract. `authorizedSigner` can be:
///           - baseline: the relayer's secp256k1 key (ships day one), or
///           - upgrade:  the 0G Compute TEE enclave key (if proven in the spike).
///         The contract does not care which — same recovery path. That is the
///         graceful-degradation property the whole build leans on.
///
///         Dependency-free on purpose: no OZ import, so the spike compiles and
///         tests in seconds with nothing to install.
contract ItemVerdictVerifier {
    /// The single item verdict the AI verifier attests to and signs.
    /// Mirror this struct byte-for-byte in offchain/payload.ts or signatures
    /// will not recover. `nonceHash` binds the on-chain commitment (the host's
    /// pre-committed liveness nonce) to the thing the verifier actually checked.
    struct ItemVerdict {
        uint256 checkoutId;
        bytes32 itemId;      // keccak256(item name), e.g. "espresso_machine"
        bool    verdict;     // true = PASS
        bytes32 imageHash;   // keccak256 of the blob stored on 0G Storage
        bytes32 nonceHash;   // keccak256 of the per-item liveness nonce
        uint256 deadline;    // unix; session time-box, rejects stale verdicts
    }

    address public authorizedSigner;

    event SignerUpdated(address indexed previous, address indexed next);
    event VerdictChecked(uint256 indexed checkoutId, bytes32 indexed itemId, address recovered, bool ok);

    constructor(address signer) {
        authorizedSigner = signer;
        emit SignerUpdated(address(0), signer);
    }

    /// Swap relayer key -> TEE key (or rotate) without redeploying.
    function setAuthorizedSigner(address next) external {
        // NOTE: spike only — production gates this behind owner/timelock.
        emit SignerUpdated(authorizedSigner, next);
        authorizedSigner = next;
    }

    /// The exact 32-byte digest the off-chain signer must sign.
    /// structHash = keccak256(abi.encode(fields)); then the personal_sign prefix
    /// so it matches ethers `wallet.signMessage(getBytes(structHash))`.
    function digest(ItemVerdict calldata v) public pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline)
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash));
    }

    function recoverSigner(ItemVerdict calldata v, bytes calldata sig) public pure returns (address) {
        return _recover(digest(v), sig);
    }

    /// View check used by tests / callers. The escrow contract (next stage)
    /// calls the same recovery inline inside `verifyItemAndRelease`.
    function verify(ItemVerdict calldata v, bytes calldata sig) external view returns (bool) {
        return recoverSigner(v, sig) == authorizedSigner;
    }

    /// State-changing variant so the spike can be driven from a real tx on
    /// Hedera testnet and produce an on-chain event to point at in the demo.
    function checkAndEmit(ItemVerdict calldata v, bytes calldata sig) external returns (bool ok) {
        address rec = recoverSigner(v, sig);
        ok = rec == authorizedSigner;
        emit VerdictChecked(v.checkoutId, v.itemId, rec, ok);
    }

    // --- minimal ECDSA recover (no external dependency) --------------------
    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 vv;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            vv := byte(0, calldataload(add(sig.offset, 64)))
        }
        // reject the malleable upper-half of s
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (vv != 27 && vv != 28) return address(0);
        return ecrecover(hash, vv, r, s);
    }
}
