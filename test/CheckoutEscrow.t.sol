// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CheckoutEscrow} from "../src/CheckoutEscrow.sol";

contract CheckoutEscrowTest is Test {
    CheckoutEscrow escrow;

    uint256 verifierPk = 0xA11CE; // relayer baseline (same pattern as Stage 1)
    address verifier;

    address host = address(0xB0B0);
    address tenant = address(0x7E7E);

    uint256 constant CHECKOUT_ID = 42;
    uint256 constant DEPOSIT = 200 ether; // stands in for 200 HBAR
    uint64 deadline;

    bytes32 ITEM_MACHINE = keccak256("espresso_machine");
    bytes32 ITEM_TV = keccak256("tv");
    bytes32 ITEM_DOOR = keccak256("bedroom_door");

    bytes32 NONCE_MACHINE = keccak256("blue pen next to espresso machine");
    bytes32 NONCE_TV = keccak256("peace sign in front of tv");
    bytes32 NONCE_DOOR = keccak256("hand flat on bedroom door");

    function setUp() public {
        verifier = vm.addr(verifierPk);
        escrow = new CheckoutEscrow(verifier);
        deadline = uint64(block.timestamp + 1 days);

        vm.deal(tenant, DEPOSIT);

        bytes32[] memory items = new bytes32[](3);
        items[0] = ITEM_MACHINE;
        items[1] = ITEM_TV;
        items[2] = ITEM_DOOR;

        vm.prank(host);
        escrow.createCheckout(CHECKOUT_ID, tenant, DEPOSIT, deadline, items);

        vm.startPrank(host);
        escrow.commitNonce(CHECKOUT_ID, ITEM_MACHINE, NONCE_MACHINE);
        escrow.commitNonce(CHECKOUT_ID, ITEM_TV, NONCE_TV);
        escrow.commitNonce(CHECKOUT_ID, ITEM_DOOR, NONCE_DOOR);
        vm.stopPrank();

        vm.prank(tenant);
        escrow.deposit{value: DEPOSIT}(CHECKOUT_ID);
    }

    // -- helpers ----------------------------------------------------------
    function _verdict(bytes32 itemId, bytes32 nonceHash, bool pass)
        internal
        view
        returns (CheckoutEscrow.ItemVerdict memory v)
    {
        v = CheckoutEscrow.ItemVerdict({
            checkoutId: CHECKOUT_ID,
            itemId: itemId,
            verdict: pass,
            imageHash: keccak256(abi.encodePacked("0g://blob/", itemId)),
            nonceHash: nonceHash,
            deadline: block.timestamp + 10 minutes
        });
    }

    function _sign(uint256 pk, CheckoutEscrow.ItemVerdict memory v) internal pure returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }

    function _passItem(bytes32 itemId, bytes32 nonceHash) internal {
        CheckoutEscrow.ItemVerdict memory v = _verdict(itemId, nonceHash, true);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, _sign(verifierPk, v));
    }

    // -- 1. happy path ------------------------------------------------------
    function test_HappyPath_AllItemsPass_DepositReleases() public {
        uint256 before = tenant.balance;

        _passItem(ITEM_MACHINE, NONCE_MACHINE);
        _passItem(ITEM_TV, NONCE_TV);
        assertEq(escrow.remainingItems(CHECKOUT_ID), 1);

        _passItem(ITEM_DOOR, NONCE_DOOR);

        CheckoutEscrow.Checkout memory c = escrow.getCheckout(CHECKOUT_ID);
        assertEq(uint8(c.status), uint8(CheckoutEscrow.Status.Released));
        assertEq(tenant.balance, before + DEPOSIT, "tenant should receive full deposit");
        assertEq(address(escrow).balance, 0);
    }

    // -- 2. failure path -----------------------------------------------------
    function test_FailVerdict_DoesNotRelease() public {
        uint256 before = tenant.balance;

        _passItem(ITEM_MACHINE, NONCE_MACHINE);
        _passItem(ITEM_TV, NONCE_TV);

        // AI says the door is damaged: signed FAIL verdict.
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_DOOR, NONCE_DOOR, false);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, _sign(verifierPk, v));

        CheckoutEscrow.Checkout memory c = escrow.getCheckout(CHECKOUT_ID);
        assertEq(uint8(c.status), uint8(CheckoutEscrow.Status.Funded), "still locked");
        assertEq(tenant.balance, before, "tenant must not be paid");
        assertFalse(escrow.isItemPassed(CHECKOUT_ID, ITEM_DOOR));
    }

    function test_SwappedNonce_Reverts() public {
        // Reused/old photo simulation: verdict carries the wrong nonce.
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_MACHINE, keccak256("stale nonce"), true);
        bytes memory sig = _sign(verifierPk, v);
        vm.expectRevert(CheckoutEscrow.NonceMismatch.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);
    }

    // -- 3. timeout path ------------------------------------------------------
    function test_Timeout_ResolvesToHost() public {
        _passItem(ITEM_MACHINE, NONCE_MACHINE); // partial completion

        vm.warp(deadline + 1);
        uint256 before = host.balance;
        escrow.resolveTimeout(CHECKOUT_ID);

        CheckoutEscrow.Checkout memory c = escrow.getCheckout(CHECKOUT_ID);
        assertEq(uint8(c.status), uint8(CheckoutEscrow.Status.Resolved));
        assertEq(host.balance, before + DEPOSIT, "host should receive deposit");
    }

    function test_Timeout_BeforeDeadline_Reverts() public {
        vm.expectRevert(CheckoutEscrow.DeadlineNotReached.selector);
        escrow.resolveTimeout(CHECKOUT_ID);
    }

    // -- 4. replay / wrong checkout -------------------------------------------
    function test_ReplaySameVerdict_Reverts() public {
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_MACHINE, NONCE_MACHINE, true);
        bytes memory sig = _sign(verifierPk, v);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);

        vm.expectRevert(CheckoutEscrow.AlreadyPassed.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);

        assertEq(escrow.remainingItems(CHECKOUT_ID), 2, "no double count");
    }

    function test_WrongCheckoutId_Reverts() public {
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_MACHINE, NONCE_MACHINE, true);
        v.checkoutId = 999;
        bytes memory sig = _sign(verifierPk, v);
        vm.expectRevert(CheckoutEscrow.WrongCheckout.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);
    }

    // -- 5. only-verifier -------------------------------------------------------
    function test_UnauthorizedSigner_Reverts() public {
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_MACHINE, NONCE_MACHINE, true);
        bytes memory sig = _sign(0xB0B, v); // not the verifier
        vm.expectRevert(CheckoutEscrow.BadSignature.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);
    }

    function test_TamperedVerdict_Reverts() public {
        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_MACHINE, NONCE_MACHINE, false);
        bytes memory sig = _sign(verifierPk, v);
        v.verdict = true; // flip FAIL -> PASS after signing
        vm.expectRevert(CheckoutEscrow.BadSignature.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, sig);
    }

    // -- graceful degradation: relayer -> TEE key swap ----------------------------
    function test_VerifierSwap_TeeSignsRemainingItems() public {
        _passItem(ITEM_MACHINE, NONCE_MACHINE);

        uint256 teePk = 0x7EE;
        escrow.setVerifier(vm.addr(teePk)); // owner == this test contract

        CheckoutEscrow.ItemVerdict memory v = _verdict(ITEM_TV, NONCE_TV, true);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v, _sign(teePk, v));
        assertTrue(escrow.isItemPassed(CHECKOUT_ID, ITEM_TV));

        // old relayer key no longer accepted
        CheckoutEscrow.ItemVerdict memory v2 = _verdict(ITEM_DOOR, NONCE_DOOR, true);
        bytes memory oldSig = _sign(verifierPk, v2);
        vm.expectRevert(CheckoutEscrow.BadSignature.selector);
        escrow.verifyItemAndRelease(CHECKOUT_ID, v2, oldSig);
    }

    // -- guards ---------------------------------------------------------------
    function test_WrongDepositAmount_Reverts() public {
        bytes32[] memory items = new bytes32[](1);
        items[0] = ITEM_TV;
        vm.prank(host);
        escrow.createCheckout(77, tenant, DEPOSIT, deadline, items);

        vm.deal(tenant, 1 ether);
        vm.prank(tenant);
        vm.expectRevert(CheckoutEscrow.WrongDeposit.selector);
        escrow.deposit{value: 1 ether}(77);
    }

    function test_VerdictWithoutCommittedNonce_Reverts() public {
        bytes32[] memory items = new bytes32[](1);
        items[0] = ITEM_TV;
        vm.prank(host);
        escrow.createCheckout(78, tenant, DEPOSIT, deadline, items);
        vm.deal(tenant, DEPOSIT);
        vm.prank(tenant);
        escrow.deposit{value: DEPOSIT}(78);

        CheckoutEscrow.ItemVerdict memory v = CheckoutEscrow.ItemVerdict({
            checkoutId: 78,
            itemId: ITEM_TV,
            verdict: true,
            imageHash: keccak256("img"),
            nonceHash: NONCE_TV,
            deadline: block.timestamp + 10 minutes
        });
        bytes memory sig = _sign(verifierPk, v);
        vm.expectRevert(CheckoutEscrow.NonceNotCommitted.selector);
        escrow.verifyItemAndRelease(78, v, sig);
    }
}
