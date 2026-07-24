// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ItemVerdictVerifier} from "../src/ItemVerdictVerifier.sol";

/// Proves the spike: a payload signed with a known secp256k1 key recovers to
/// that key inside the contract, a tampered payload does not, and a stale
/// signer is rejected. If this passes, `ecrecover` on Hedera's EVM will too.
contract ItemVerdictVerifierTest is Test {
    ItemVerdictVerifier verifier;
    uint256 signerPk = 0xA11CE; // stand-in for relayer or 0G TEE key
    address signer;

    function setUp() public {
        signer = vm.addr(signerPk);
        verifier = new ItemVerdictVerifier(signer);
    }

    function _sample() internal pure returns (ItemVerdictVerifier.ItemVerdict memory v) {
        v = ItemVerdictVerifier.ItemVerdict({
            checkoutId: 1,
            itemId: keccak256("espresso_machine"),
            verdict: true,
            imageHash: keccak256("0g://blob/abc"),
            nonceHash: keccak256("blue pen next to espresso machine"),
            deadline: 1_900_000_000
        });
    }

    function _sign(uint256 pk, ItemVerdictVerifier.ItemVerdict memory v) internal view returns (bytes memory) {
        bytes32 d = verifier.digest(v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, d);
        return abi.encodePacked(r, s, vv);
    }

    function test_ValidSignatureRecovers() public view {
        ItemVerdictVerifier.ItemVerdict memory v = _sample();
        bytes memory sig = _sign(signerPk, v);
        assertEq(verifier.recoverSigner(v, sig), signer, "recovered != signer");
        assertTrue(verifier.verify(v, sig), "verify() should pass");
    }

    function test_TamperedVerdictFails() public view {
        ItemVerdictVerifier.ItemVerdict memory v = _sample();
        bytes memory sig = _sign(signerPk, v);
        v.verdict = false; // flip PASS->FAIL after signing
        assertFalse(verifier.verify(v, sig), "tampered payload must not verify");
    }

    function test_ReusedNonceHashFails() public view {
        // Simulates a reused/old photo: verifier signed for nonce A, attacker
        // swaps in nonce B. Signature no longer matches -> no release.
        ItemVerdictVerifier.ItemVerdict memory v = _sample();
        bytes memory sig = _sign(signerPk, v);
        v.nonceHash = keccak256("some other nonce");
        assertFalse(verifier.verify(v, sig), "swapped nonce must not verify");
    }

    function test_WrongSignerRejected() public {
        ItemVerdictVerifier.ItemVerdict memory v = _sample();
        bytes memory sig = _sign(0xB0B, v); // not the authorized key
        assertFalse(verifier.verify(v, sig), "unauthorized signer must fail");
    }

    function test_SignerSwapRelayerToTee() public {
        // The graceful-degradation property: same contract, swap the signer.
        ItemVerdictVerifier.ItemVerdict memory v = _sample();
        uint256 teePk = 0x7EE;
        address teeAddr = vm.addr(teePk);
        verifier.setAuthorizedSigner(teeAddr);
        bytes memory sig = _sign(teePk, v);
        assertTrue(verifier.verify(v, sig), "TEE-signed verdict should verify after swap");
    }
}
