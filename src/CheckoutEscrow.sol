// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CheckoutEscrow — Stage 2 of Aivy Checkout
/// @notice Itemized rental-checkout escrow. The host defines a checklist at
///         creation; the tenant funds the deposit; an authorized AI verifier
///         signs per-item verdicts (ItemVerdict digest proven in Stage 1).
///         All items pass -> deposit releases to tenant. Deadline expires
///         first -> host resolves. Funds can never lock forever.
///
///         Reuses the EXACT ItemVerdict struct + personal_sign digest proven
///         by ItemVerdictVerifier.t.sol and offchain/parity-check.ts. Do not
///         alter field order or encoding.
contract CheckoutEscrow {
    // ------------------------------------------------------------------
    // Signed payload — byte-identical to Stage 1 (src/ItemVerdictVerifier.sol
    // and offchain/payload.ts). Single source of truth across the stack.
    // ------------------------------------------------------------------
    struct ItemVerdict {
        uint256 checkoutId;
        bytes32 itemId;      // keccak256(item name)
        bool    verdict;     // true = PASS
        bytes32 imageHash;   // keccak256 of the 0G Storage blob
        bytes32 nonceHash;   // keccak256 of the per-item liveness nonce
        uint256 deadline;    // unix; session time-box for this verdict
    }

    enum Status { None, Created, Funded, Released, Resolved }

    struct Checkout {
        address host;
        address tenant;
        uint256 deposit;        // agreed deposit in tinybar (msg.value units)
        uint64  deadline;       // checkout must complete by this time
        uint8   requiredItems;
        uint8   passedItems;
        Status  status;
    }

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------
    address public verifier;   // relayer key baseline; swappable to 0G TEE key
    address public owner;      // deploys + governs signer swaps (hackathon-simple)

    mapping(uint256 => Checkout) public checkouts;
    // checkoutId => itemId => required?
    mapping(uint256 => mapping(bytes32 => bool)) public isRequiredItem;
    // checkoutId => itemId => committed liveness nonce hash
    mapping(uint256 => mapping(bytes32 => bytes32)) public committedNonce;
    // checkoutId => itemId => passed?
    mapping(uint256 => mapping(bytes32 => bool)) public itemPassed;

    // ------------------------------------------------------------------
    // Events (relayer indexes these; Released/Resolved trigger the HCS receipt)
    // ------------------------------------------------------------------
    event CheckoutCreated(uint256 indexed checkoutId, address indexed host, address indexed tenant, uint256 deposit, uint64 deadline, uint8 requiredItems);
    event NonceCommitted(uint256 indexed checkoutId, bytes32 indexed itemId, bytes32 nonceHash);
    event Deposited(uint256 indexed checkoutId, address indexed tenant, uint256 amount);
    event ItemVerified(uint256 indexed checkoutId, bytes32 indexed itemId, bool pass, bytes32 imageHash);
    event DepositReleased(uint256 indexed checkoutId, address indexed tenant, uint256 amount);
    event CheckoutResolved(uint256 indexed checkoutId, address indexed host, uint256 amount);
    event VerifierUpdated(address indexed previous, address indexed next);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error NotOwner();
    error NotHost();
    error BadStatus();
    error AlreadyExists();
    error NoItems();
    error DuplicateItem();
    error UnknownItem();
    error PastDeadline();
    error DeadlineNotReached();
    error WrongDeposit();
    error WrongCheckout();
    error StaleVerdict();
    error NonceMismatch();
    error NonceNotCommitted();
    error AlreadyPassed();
    error BadSignature();
    error TransferFailed();

    constructor(address _verifier) {
        owner = msg.sender;
        verifier = _verifier;
        emit VerifierUpdated(address(0), _verifier);
    }

    /// Swap relayer key -> 0G TEE enclave key without redeploying.
    function setVerifier(address next) external {
        if (msg.sender != owner) revert NotOwner();
        emit VerifierUpdated(verifier, next);
        verifier = next;
    }

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    /// Host records the checklist. Deposit amount is fixed here so the tenant
    /// can't underfund and the host can't move the goalposts after funding.
    function createCheckout(
        uint256 checkoutId,
        address tenant,
        uint256 depositAmount,
        uint64 deadline,
        bytes32[] calldata itemIds
    ) external {
        if (checkouts[checkoutId].status != Status.None) revert AlreadyExists();
        if (itemIds.length == 0 || itemIds.length > 32) revert NoItems();
        if (deadline <= block.timestamp) revert PastDeadline();

        for (uint256 i = 0; i < itemIds.length; i++) {
            if (isRequiredItem[checkoutId][itemIds[i]]) revert DuplicateItem();
            isRequiredItem[checkoutId][itemIds[i]] = true;
        }

        checkouts[checkoutId] = Checkout({
            host: msg.sender,
            tenant: tenant,
            deposit: depositAmount,
            deadline: deadline,
            requiredItems: uint8(itemIds.length),
            passedItems: 0,
            status: Status.Created
        });

        emit CheckoutCreated(checkoutId, msg.sender, tenant, depositAmount, deadline, uint8(itemIds.length));
    }

    /// Backend/host commits the per-item liveness nonce hash BEFORE capture.
    /// Recommitting overwrites (a fresh nonce per session is fine — the verdict
    /// must match whatever was last committed before it was signed).
    function commitNonce(uint256 checkoutId, bytes32 itemId, bytes32 nonceHash) external {
        Checkout storage c = checkouts[checkoutId];
        if (c.status != Status.Created && c.status != Status.Funded) revert BadStatus();
        if (msg.sender != c.host) revert NotHost();
        if (block.timestamp >= c.deadline) revert PastDeadline();
        if (!isRequiredItem[checkoutId][itemId]) revert UnknownItem();

        committedNonce[checkoutId][itemId] = nonceHash;
        emit NonceCommitted(checkoutId, itemId, nonceHash);
    }

    /// Tenant locks the exact agreed deposit in native HBAR.
    function deposit(uint256 checkoutId) external payable {
        Checkout storage c = checkouts[checkoutId];
        if (c.status != Status.Created) revert BadStatus();
        if (msg.value != c.deposit) revert WrongDeposit();
        if (block.timestamp >= c.deadline) revert PastDeadline();

        c.status = Status.Funded;
        emit Deposited(checkoutId, msg.sender, msg.value);
    }

    /// The core: accept a verifier-signed per-item verdict. When the final
    /// required item passes, release the full deposit to the tenant.
    /// Anyone may submit (the relayer does); trust comes from the signature.
    function verifyItemAndRelease(uint256 checkoutId, ItemVerdict calldata v, bytes calldata sig) external {
        Checkout storage c = checkouts[checkoutId];
        if (c.status != Status.Funded) revert BadStatus();
        if (v.checkoutId != checkoutId) revert WrongCheckout();
        if (block.timestamp >= c.deadline) revert PastDeadline();
        if (v.deadline < block.timestamp) revert StaleVerdict();
        if (!isRequiredItem[checkoutId][v.itemId]) revert UnknownItem();
        if (itemPassed[checkoutId][v.itemId]) revert AlreadyPassed();

        bytes32 committed = committedNonce[checkoutId][v.itemId];
        if (committed == bytes32(0)) revert NonceNotCommitted();
        if (v.nonceHash != committed) revert NonceMismatch();

        if (_recover(_digest(v), sig) != verifier) revert BadSignature();

        emit ItemVerified(checkoutId, v.itemId, v.verdict, v.imageHash);

        if (!v.verdict) {
            // FAIL verdict is recorded via the event; deposit stays locked.
            // Host recovers via resolveTimeout after the deadline.
            return;
        }

        itemPassed[checkoutId][v.itemId] = true;
        c.passedItems += 1;

        if (c.passedItems == c.requiredItems) {
            // checks-effects-interactions: set status BEFORE transferring
            c.status = Status.Released;
            uint256 amount = c.deposit;
            emit DepositReleased(checkoutId, c.tenant, amount);
            (bool ok, ) = c.tenant.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// After the deadline, an incomplete checkout resolves to the host.
    /// Guarantees funds can never lock forever.
    function resolveTimeout(uint256 checkoutId) external {
        Checkout storage c = checkouts[checkoutId];
        if (c.status != Status.Funded) revert BadStatus();
        if (block.timestamp < c.deadline) revert DeadlineNotReached();

        c.status = Status.Resolved;
        uint256 amount = c.deposit;
        emit CheckoutResolved(checkoutId, c.host, amount);
        (bool ok, ) = c.host.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getCheckout(uint256 checkoutId) external view returns (Checkout memory) {
        return checkouts[checkoutId];
    }

    function isItemPassed(uint256 checkoutId, bytes32 itemId) external view returns (bool) {
        return itemPassed[checkoutId][itemId];
    }

    function remainingItems(uint256 checkoutId) external view returns (uint8) {
        Checkout storage c = checkouts[checkoutId];
        return c.requiredItems - c.passedItems;
    }

    // ------------------------------------------------------------------
    // Signature core — identical to Stage 1's proven ItemVerdictVerifier
    // ------------------------------------------------------------------
    function _digest(ItemVerdict calldata v) internal pure returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(v.checkoutId, v.itemId, v.verdict, v.imageHash, v.nonceHash, v.deadline)
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash));
    }

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
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        if (vv != 27 && vv != 28) return address(0);
        return ecrecover(hash, vv, r, s);
    }
}
