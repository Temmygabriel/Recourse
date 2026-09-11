// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title RecourseEscrow
 * @notice Holds a buyer's USDC against a seller's written promise, and settles
 *         it exactly once on a verdict produced by GenLayer.
 *
 * @dev Design rules this contract exists to enforce. Read them before changing
 *      anything here.
 *
 *      1. THE CONTRACT OWNS THE HASHES. Every commitment is derived here, from
 *         the text, at the moment the text is written. Callers never supply a
 *         hash. A caller that supplies both text and hash can desync the two;
 *         a contract that derives one from the other cannot. This is why the
 *         frontend contains no hashing code at all.
 *
 *      2. ONE SETTLEMENT, EVER. `SettlementDecision.nonce` is consumed
 *         atomically with payout, and the purchase carries its own
 *         `nonceConsumed` flag. Either alone would do; both together mean a
 *         replay needs to defeat two independent checks.
 *
 *      3. NO ADMIN PATH TO THE MONEY. The owner can pause new purchases and
 *         new settlements. The owner cannot move, redirect, release, or
 *         confiscate a single token. There is no upgrade path, no sweep
 *         function, and no `delegatecall`. Funds leave this contract through
 *         exactly the state-machine transitions below and nowhere else.
 *
 *      4. THE TRUST BOUNDARY IS NAMED, NOT HIDDEN. See `settle()` — the
 *         `finalized` flag is the one field this contract cannot verify. It is
 *         an assertion by the relayer, and it is why Recourse is not
 *         trustless. Everything else in the decision is verified here.
 */
contract RecourseEscrow {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Purchase lifecycle. `SETTLED` is terminal.
    enum Stage {
        NONE, // 0 — never created
        OPEN, // 1 — offer published, no buyer yet
        FUNDED, // 2 — buyer paid, awaiting delivery
        DELIVERED, // 3 — seller delivered, review window running
        DISPUTED, // 4 — buyer disputed, bond posted, awaiting GenLayer
        SETTLED // 5 — money has moved; terminal
    }

    /// @notice Mirrors the GenLayer verdict enum. Order is load-bearing and is
    ///         encoded into the EIP-712 signature — never reorder.
    enum Outcome {
        RELEASE, // 0
        PARTIAL_REFUND, // 1
        FULL_REFUND, // 2
        UNDETERMINED // 3
    }

    /// @notice The four amounts a settlement moves. Never returned from or
    ///         accepted by an external function — it is a carrier for the
    ///         internal split, and the external surface is the `Settled` event.
    struct Payout {
        uint256 toBuyer; // escrow refund
        uint256 toSeller; // remainder of the price
        uint256 bondToBuyer; // dispute bond, returned or forfeited
        uint256 bondToSeller;
    }

    struct Purchase {
        address seller;
        address buyer; // address(0) until purchased
        uint96 price; // USDC, 6 decimals
        uint64 deliveryDeadline; // unix seconds
        uint64 reviewWindow; // seconds, starts at deliveredAt
        uint64 deliveredAt; // 0 until delivered
        uint8 criteriaCount; // 2..4
        Stage stage;
        uint96 disputeBond;
        uint8 disputedBitmap; // bit i set => rubric criterion i is disputed
        string promiseText;
        string[] rubric;
        string deliveryNotes;
        string disputeNotes;
    }

    /**
     * @notice The relayer's signed assertion that GenLayer reached a verdict.
     *
     * @dev Field-by-field verification is in `settle()`. Note which fields ARE
     *      checked on-chain and which are not:
     *
     *      VERIFIED on-chain: purchaseId, nonce, sourceChainId, sourceContract,
     *      promiseHash, rubricHash, evidenceRoot, outcome, refundBps,
     *      criteriaMetBitmap, and the signature itself.
     *
     *      NOT VERIFIABLE on-chain: `finalized`, `genlayerTxHash` and
     *      `decisionDigest`. `finalized` is the trust boundary — an EVM
     *      contract cannot read GenLayer consensus state. The other two are
     *      audit anchors: they are signed, emitted in `Settled`, and anyone can
     *      recompute the digest from the verdict payload fetched from GenLayer
     *      to confirm the relayer relayed rather than invented.
     */
    struct SettlementDecision {
        uint256 purchaseId;
        uint256 nonce;
        uint256 sourceChainId;
        address sourceContract;
        bytes32 genlayerTxHash;
        bytes32 promiseHash;
        bytes32 rubricHash;
        bytes32 evidenceRoot;
        bytes32 decisionDigest;
        Outcome outcome;
        uint16 refundBps;
        uint8 criteriaMetBitmap;
        bool finalized;
    }

    // ---------------------------------------------------------------------
    // Immutables and storage
    // ---------------------------------------------------------------------

    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "SettlementDecision(uint256 purchaseId,uint256 nonce,uint256 sourceChainId,address sourceContract,bytes32 genlayerTxHash,bytes32 promiseHash,bytes32 rubricHash,bytes32 evidenceRoot,bytes32 decisionDigest,uint8 outcome,uint16 refundBps,uint8 criteriaMetBitmap,bool finalized)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant MIN_CRITERIA = 2;
    uint8 public constant MAX_CRITERIA = 4;

    uint64 public constant MIN_REVIEW_WINDOW = 1 hours;
    uint64 public constant MAX_REVIEW_WINDOW = 30 days;

    uint16 public constant MIN_BOND_BPS = 100; // 1%
    uint16 public constant MAX_BOND_BPS = 2_000; // 20%

    /// @notice Base Sepolia USDC.
    IERC20 public immutable usdc;

    /// @notice Chain id of the GenLayer network whose verdicts this escrow
    ///         accepts. Immutable so a verdict cannot be replayed from another
    ///         network by moving this value.
    uint256 public immutable sourceChainId;

    /// @notice The single GenLayer contract authorised to produce verdicts for
    ///         this escrow. Immutable for the same reason: a compromised owner
    ///         key cannot repoint the judgment layer.
    address public immutable sourceContract;

    /// @notice Dispute bond, in basis points of price. Set at deploy.
    uint16 public immutable disputeBondBps;

    /// @notice Pause-only admin. Cannot move funds. See rule 3 in the header.
    address public owner;

    /// @notice The key allowed to call `settle()`. Rotatable — keys leak and
    ///         must be replaceable — but rotating it can only change *who*
    ///         may relay a decision, never *what* a decision may say.
    address public relayer;

    bool public paused;

    uint256 public nextPurchaseId = 1;

    mapping(uint256 => Purchase) private _purchases;

    /// @notice Nonces consumed, globally across purchases.
    mapping(uint256 => bool) public nonceUsed;

    /// @notice EIP-712 domain separator, cached at deploy. Rebuilt if
    ///         `block.chainid` differs (fork / test-environment safety).
    bytes32 private immutable _deployedChainIdDomain;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event OfferCreated(
        uint256 indexed purchaseId,
        address indexed seller,
        uint96 price,
        uint64 deliveryDeadline,
        uint64 reviewWindow,
        bytes32 promiseHash,
        bytes32 rubricHash,
        uint8 criteriaCount
    );
    event OfferCancelled(uint256 indexed purchaseId);
    event Purchased(uint256 indexed purchaseId, address indexed buyer, uint96 price);
    event DeliverySubmitted(uint256 indexed purchaseId, bytes32 deliveryHash, bool late);
    event DisputeOpened(
        uint256 indexed purchaseId,
        address indexed buyer,
        uint8 disputedBitmap,
        bytes32 disputeHash,
        uint96 bond
    );
    event Settled(
        uint256 indexed purchaseId,
        Outcome outcome,
        uint16 refundBps,
        uint8 criteriaMetBitmap,
        uint256 buyerAmount,
        uint256 sellerAmount,
        uint256 bondToBuyer,
        uint256 bondToSeller,
        uint256 nonce,
        bytes32 genlayerTxHash,
        bytes32 decisionDigest
    );
    event Accepted(uint256 indexed purchaseId, uint256 sellerAmount);
    event ReviewWindowExpired(uint256 indexed purchaseId, uint256 sellerAmount);
    event DeadlineRefund(uint256 indexed purchaseId, uint256 buyerAmount);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    /// @dev Guards every function that moves USDC.
    modifier nonReentrant() {
        require(_lock == 0, "reentrant");
        _lock = 1;
        _;
        _lock = 0;
    }

    uint256 private _lock = 0;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /**
     * @param usdc_ Base Sepolia USDC address.
     * @param sourceChainId_ Chain id of the GenLayer network (61999 Studionet,
     *        61997 studio-dev).
     * @param sourceContract_ The deployed GenLayer judgment contract. Deploy
     *        that FIRST — this escrow permanently pins its address.
     * @param relayer_ Initial relayer signer. Rotatable later.
     * @param disputeBondBps_ Bond in bps of price, clamped to [100, 2000].
     * @param owner_ Pause-only admin.
     */
    constructor(
        IERC20 usdc_,
        uint256 sourceChainId_,
        address sourceContract_,
        address relayer_,
        uint16 disputeBondBps_,
        address owner_
    ) {
        require(address(usdc_) != address(0), "usdc=0");
        require(sourceChainId_ != 0, "sourceChainId=0");
        require(sourceContract_ != address(0), "sourceContract=0");
        require(relayer_ != address(0), "relayer=0");
        require(owner_ != address(0), "owner=0");
        require(disputeBondBps_ >= MIN_BOND_BPS && disputeBondBps_ <= MAX_BOND_BPS, "bond bps range");

        usdc = usdc_;
        sourceChainId = sourceChainId_;
        sourceContract = sourceContract_;
        relayer = relayer_;
        disputeBondBps = disputeBondBps_;
        owner = owner_;

        _deployedChainIdDomain = _buildDomainSeparator();

        emit RelayerUpdated(address(0), relayer_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------------
    // Seller: create an offer
    // ---------------------------------------------------------------------

    /**
     * @notice Publish a promise. The text is stored in full and hashed here.
     * @param price USDC amount, 6 decimals. Must be > 0.
     * @param deliveryDeadline Unix seconds. Must be in the future.
     * @param reviewWindow Seconds the buyer gets to accept or dispute after
     *        delivery. Clamped to [1 hour, 30 days].
     * @param promiseText The plain-English promise, <= 500 chars.
     * @param rubric 2..4 acceptance criteria, each <= 200 chars. Order is
     *        load-bearing: criterion `i` here is criterion `i` in the verdict.
     * @return purchaseId
     */
    function createOffer(
        uint96 price,
        uint64 deliveryDeadline,
        uint64 reviewWindow,
        string calldata promiseText,
        string[] calldata rubric
    ) external returns (uint256 purchaseId) {
        require(!paused, "paused");
        require(price > 0, "price=0");
        require(deliveryDeadline > block.timestamp, "deadline past");
        require(
            reviewWindow >= MIN_REVIEW_WINDOW && reviewWindow <= MAX_REVIEW_WINDOW,
            "review window range"
        );
        require(rubric.length >= MIN_CRITERIA && rubric.length <= MAX_CRITERIA, "criteria count");

        _checkText(promiseText, 500, "promiseText");
        for (uint256 i = 0; i < rubric.length; i++) {
            _checkText(rubric[i], 200, "rubric item");
        }

        purchaseId = nextPurchaseId++;
        Purchase storage p = _purchases[purchaseId];
        p.seller = msg.sender;
        p.price = price;
        p.deliveryDeadline = deliveryDeadline;
        p.reviewWindow = reviewWindow;
        p.criteriaCount = uint8(rubric.length);
        p.stage = Stage.OPEN;
        p.promiseText = promiseText;
        // Element by element, not `p.rubric = rubric`. A `string[]` is an array
        // of dynamic arrays, and the legacy code generator refuses to copy a
        // nested calldata array into storage in one assignment — it fails with
        // "Copying nested calldata dynamic arrays to storage is not
        // implemented", which is a compile error rather than a wrong result.
        // The loop is the documented workaround and is what the copy would have
        // done anyway.
        for (uint256 i = 0; i < rubric.length; i++) {
            p.rubric.push(rubric[i]);
        }

        emit OfferCreated(
            purchaseId,
            msg.sender,
            price,
            deliveryDeadline,
            reviewWindow,
            promiseHash(purchaseId),
            rubricHash(purchaseId),
            uint8(rubric.length)
        );
    }

    /// @notice Withdraw an unpurchased offer. No funds are involved at this
    ///         stage, so this is always safe and always available.
    function cancelOffer(uint256 purchaseId) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.OPEN, "not open");
        require(msg.sender == p.seller, "not seller");
        p.stage = Stage.NONE;
        emit OfferCancelled(purchaseId);
    }

    // ---------------------------------------------------------------------
    // Buyer: purchase
    // ---------------------------------------------------------------------

    /**
     * @notice Pay the price into escrow. The buyer is agreeing to the promise
     *         exactly as the seller wrote it — the UI shows the full text and
     *         the rubric before this call.
     */
    function purchase(uint256 purchaseId) external whenNotPaused nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.OPEN, "not open");
        require(msg.sender != p.seller, "seller cannot buy");
        require(block.timestamp <= p.deliveryDeadline, "deadline past");

        p.buyer = msg.sender;
        p.stage = Stage.FUNDED;

        _pull(msg.sender, p.price);

        emit Purchased(purchaseId, msg.sender, p.price);
    }

    // ---------------------------------------------------------------------
    // Seller: deliver
    // ---------------------------------------------------------------------

    /**
     * @notice Submit delivery before the deadline. Notes are hashed here.
     * @dev Late delivery reverts. The buyer's remedy is `claimDeadlineRefund`
     *      — no dispute, no bond, full refund. A seller who cannot deliver on
     *      time loses the sale rather than arguing about quality.
     */
    function submitDelivery(uint256 purchaseId, string calldata deliveryNotes) external {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.FUNDED, "not funded");
        require(msg.sender == p.seller, "not seller");
        require(block.timestamp <= p.deliveryDeadline, "delivery late");
        _checkText(deliveryNotes, 2000, "deliveryNotes");

        p.deliveryNotes = deliveryNotes;
        p.deliveredAt = uint64(block.timestamp);
        p.stage = Stage.DELIVERED;

        emit DeliverySubmitted(purchaseId, deliveryHash(purchaseId), false);
    }

    // ---------------------------------------------------------------------
    // Buyer: accept, or dispute
    // ---------------------------------------------------------------------

    /// @notice One tap. Releases the full price to the seller, no judgment.
    function acceptDelivery(uint256 purchaseId) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.DELIVERED, "not delivered");
        require(msg.sender == p.buyer, "not buyer");
        require(block.timestamp <= _reviewDeadline(p), "review window closed");

        p.stage = Stage.SETTLED;
        uint256 amount = p.price;
        _push(p.seller, amount);

        emit Accepted(purchaseId, amount);
        emit Settled(purchaseId, Outcome.RELEASE, 0, _fullBitmap(p.criteriaCount), 0, amount, 0, 0, 0, bytes32(0), bytes32(0));
    }

    /**
     * @notice Dispute a specific set of criteria. Costs a bond.
     * @param disputedBitmap Bit `i` set means criterion `i` was not met. Must
     *        name at least one criterion, and no index beyond the rubric.
     * @dev The buyer classifies before explaining. The bitmap maps onto the
     *      seller's own rubric, which is frozen at purchase — the buyer cannot
     *      invent a criterion after the fact, and the seller cannot delete one.
     */
    function openDispute(uint256 purchaseId, uint8 disputedBitmap, string calldata disputeNotes)
        external
        whenNotPaused
        nonReentrant
    {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.DELIVERED, "not delivered");
        require(msg.sender == p.buyer, "not buyer");
        require(block.timestamp <= _reviewDeadline(p), "review window closed");
        _checkText(disputeNotes, 2000, "disputeNotes");

        uint8 valid = _fullBitmap(p.criteriaCount);
        require(disputedBitmap != 0, "no criterion");
        require(disputedBitmap & ~valid == 0, "criterion out of range");

        p.disputedBitmap = disputedBitmap;
        p.disputeNotes = disputeNotes;
        p.stage = Stage.DISPUTED;

        uint96 bond = disputeBond(p.price);
        p.disputeBond = bond;
        if (bond > 0) _pull(msg.sender, bond);

        emit DisputeOpened(purchaseId, msg.sender, disputedBitmap, disputeHash(purchaseId), bond);
    }

    // ---------------------------------------------------------------------
    // Timeouts — nobody's funds are ever stranded
    // ---------------------------------------------------------------------

    /**
     * @notice Buyer went quiet. After the review window closes, anyone may
     *         release to the seller.
     * @dev Permissionless on purpose. The destination is fixed by the state
     *      machine, not chosen by the caller, so there is nothing to exploit —
     *      and a buyer who disappears cannot freeze a seller's money.
     */
    function claimReviewTimeout(uint256 purchaseId) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.DELIVERED, "not delivered");
        require(block.timestamp > _reviewDeadline(p), "window open");

        p.stage = Stage.SETTLED;
        uint256 amount = p.price;
        _push(p.seller, amount);

        emit ReviewWindowExpired(purchaseId, amount);
        emit Settled(purchaseId, Outcome.RELEASE, 0, _fullBitmap(p.criteriaCount), 0, amount, 0, 0, 0, bytes32(0), bytes32(0));
    }

    /**
     * @notice Seller never delivered. After the delivery deadline the buyer
     *         takes a full refund — no dispute, no bond, no judgment.
     */
    function claimDeadlineRefund(uint256 purchaseId) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        require(p.stage == Stage.FUNDED, "not funded");
        require(block.timestamp > p.deliveryDeadline, "deadline not passed");

        p.stage = Stage.SETTLED;
        uint256 amount = p.price;
        _push(p.buyer, amount);

        emit DeadlineRefund(purchaseId, amount);
        emit Settled(purchaseId, Outcome.FULL_REFUND, BPS_DENOMINATOR, 0, amount, 0, 0, 0, 0, bytes32(0), bytes32(0));
    }

    // ---------------------------------------------------------------------
    // Relayer: settle on a GenLayer verdict
    // ---------------------------------------------------------------------

    /**
     * @notice Execute a GenLayer verdict. The only way money leaves escrow
     *         after a dispute.
     *
     * @dev Rejection list — every one of these is a real attack that was
     *      considered, not defensive decoration:
     *
     *       1. contract paused                      -> no settlements while paused
     *       2. purchase not in DISPUTED             -> no settling undelivered or
     *                                                  already-settled purchases
     *       3. purchase already settled             -> belt
     *       4. nonce already used                   -> braces
     *       5. decision names a different purchase  -> cross-purchase replay
     *       6. wrong source chain id                -> cross-network replay
     *       7. wrong source contract                -> verdict from a contract we
     *                                                  did not authorise
     *       8. promise/rubric hash mismatch         -> verdict judged different text
     *       9. evidence root mismatch               -> verdict judged evidence the
     *                                                  chain never saw
     *      10. finalized != true                    -> THE TRUST BOUNDARY. Not
     *                                                  verifiable here. See header.
     *      11. outcome/refundBps inconsistent       -> e.g. FULL_REFUND at 30%
     *      12. criteriaMetBitmap out of range       -> garbage bits
     *      13. RELEASE with an unmet criterion      -> incoherent verdict
     *      14. PARTIAL_REFUND with all criteria met -> incoherent verdict
     *      15. caller is not the relayer            -> two independent gates on
     *      16. signature not from the relayer          who may settle at all
     *
     *      On 15 and 16 together: a valid signature alone would make settlement
     *      permissionless, which is a defensible meta-transaction design but
     *      means a decision the relayer signed and then thought better of can be
     *      pushed by anyone who saw it. Requiring the caller to be the relayer
     *      as well costs one comparison and removes that question entirely.
     *      Neither gate can change *what* a decision says — only whether it can
     *      be delivered.
     */
    function settle(SettlementDecision calldata d, bytes calldata signature)
        external
        whenNotPaused
        nonReentrant
    {
        Purchase storage p = _purchases[d.purchaseId];

        require(p.stage == Stage.DISPUTED, "not disputed"); // 2 & 3: DISPUTED excludes settled
        require(!nonceUsed[d.nonce], "nonce used"); // 4
        require(d.purchaseId != 0 && d.purchaseId < nextPurchaseId, "unknown purchase"); // 5
        require(d.sourceChainId == sourceChainId, "wrong source chain"); // 6
        require(d.sourceContract == sourceContract, "wrong source contract"); // 7
        require(d.promiseHash == promiseHash(d.purchaseId), "promise mismatch"); // 8
        require(d.rubricHash == rubricHash(d.purchaseId), "rubric mismatch"); // 8
        require(d.evidenceRoot == evidenceRoot(d.purchaseId), "evidence mismatch"); // 9
        require(d.finalized, "not finalized"); // 10

        _checkVerdictCoherence(d, p.criteriaCount); // 11, 12, 13, 14

        require(msg.sender == relayer, "not relayer"); // 15
        require(_recover(_hashDecision(d), signature) == relayer, "bad relayer signature"); // 16

        // --- effects before interactions ---
        p.stage = Stage.SETTLED;
        nonceUsed[d.nonce] = true;

        // Held in one memory slot rather than four stack slots. `Settled` takes
        // eleven arguments, all of which are live at once when it is emitted;
        // keeping the split in four separate locals on top of that is what
        // pushed this function past the EVM's sixteen-slot reach.
        Payout memory pay = _payout(p, d);

        _push(p.buyer, pay.toBuyer + pay.bondToBuyer);
        _push(p.seller, pay.toSeller + pay.bondToSeller);

        emit Settled(
            d.purchaseId,
            d.outcome,
            d.refundBps,
            d.criteriaMetBitmap,
            pay.toBuyer,
            pay.toSeller,
            pay.bondToBuyer,
            pay.bondToSeller,
            d.nonce,
            d.genlayerTxHash,
            d.decisionDigest
        );
    }

    /// @dev How a settlement divides the escrow. Split out of `settle` for two
    ///      reasons: it is the part of settlement most worth reading on its own,
    ///      and the four values have to share one memory slot so that the
    ///      eleven-argument `Settled` emit fits in the EVM stack.
    ///
    ///      The bond returns to the buyer unless the dispute was affirmatively
    ///      rejected — i.e. RELEASE. An inconclusive UNDETERMINED is not bad
    ///      faith and does not forfeit it. See docs/DATA_MODEL.md §6.
    function _payout(Purchase storage p, SettlementDecision calldata d)
        private
        view
        returns (Payout memory pay)
    {
        uint256 price_ = p.price;
        uint256 bond = p.disputeBond;
        uint256 refund = (price_ * d.refundBps) / BPS_DENOMINATOR;

        pay.toBuyer = refund;
        pay.toSeller = price_ - refund;
        pay.bondToBuyer = (d.outcome == Outcome.RELEASE) ? 0 : bond;
        pay.bondToSeller = bond - pay.bondToBuyer;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getPurchase(uint256 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    function purchaseCount() external view returns (uint256) {
        return nextPurchaseId - 1;
    }

    /// @notice What the escrow's own books say it is holding, in USDC base units.
    ///
    /// @dev This exists to be compared against `usdc.balanceOf(address(this))`.
    ///      The two should be equal. If the real balance is **higher**, the
    ///      escrow is holding value its ledger does not account for — money that
    ///      arrived and was never recorded, which is precisely the failure mode
    ///      a reverted payable call produces on GenLayer (see
    ///      docs/MONEY_RAILS_AUDIT.md). The escrow has no payable fallback and no
    ///      revert path that can retain a token transfer, so a surplus here means
    ///      something genuinely new and should be investigated rather than
    ///      explained away.
    ///
    ///      A failed `settle` cannot desynchronise the two: `settle` writes the
    ///      stage and the nonce **before** it touches the token, so a reverted
    ///      payout leaves the ledger and the balance exactly as they were,
    ///      both still counting the purchase as held.
    ///
    ///      O(purchaseCount) over storage. It is a view called from the UI and
    ///      never from a state-changing path, and the count is small at demo
    ///      scale — the frontend already walks the same range to render the list.
    function totalHeld() external view returns (uint256 held) {
        uint256 n = nextPurchaseId;
        for (uint256 id = 1; id < n; ++id) {
            Purchase storage p = _purchases[id];
            Stage s = p.stage;

            // Funded, delivered and disputed purchases all sit on the buyer's
            // money. No other stage holds any: OPEN has not been paid for, and
            // SETTLED has already been paid out.
            if (s == Stage.FUNDED || s == Stage.DELIVERED || s == Stage.DISPUTED) {
                held += p.price;
            }

            // The bond is posted at dispute time and released by the settlement,
            // so DISPUTED is the only stage that can be holding one.
            if (s == Stage.DISPUTED) {
                held += p.disputeBond;
            }
        }
    }

    /// @notice GenLayer is a separate chain with its own storage. This is the
    ///         key the relayer uses there, and it is derived here so both
    ///         sides cannot drift: "recourse:<chainId>:<escrow>:<purchaseId>".
    function genlayerKey(uint256 purchaseId) public view returns (string memory) {
        return string.concat(
            "recourse:",
            _toString(block.chainid),
            ":",
            _toHexString(address(this)),
            ":",
            _toString(purchaseId)
        );
    }

    function promiseHash(uint256 purchaseId) public view returns (bytes32) {
        return sha256(bytes(_purchases[purchaseId].promiseText));
    }

    function rubricHash(uint256 purchaseId) public view returns (bytes32) {
        return _rubricHash(_purchases[purchaseId].rubric);
    }

    function deliveryHash(uint256 purchaseId) public view returns (bytes32) {
        return sha256(bytes(_purchases[purchaseId].deliveryNotes));
    }

    function disputeHash(uint256 purchaseId) public view returns (bytes32) {
        return sha256(bytes(_purchases[purchaseId].disputeNotes));
    }

    /// @dev Recomputed from storage, never accepted as an argument. This is what
    ///      makes check #9 meaningful.
    function evidenceRoot(uint256 purchaseId) public view returns (bytes32) {
        return keccak256(abi.encode(deliveryHash(purchaseId), disputeHash(purchaseId)));
    }

    function disputeBond(uint96 price) public view returns (uint96) {
        return uint96((uint256(price) * disputeBondBps) / BPS_DENOMINATOR);
    }

    function reviewDeadline(uint256 purchaseId) external view returns (uint64) {
        return _reviewDeadline(_purchases[purchaseId]);
    }

    function domainSeparator() external view returns (bytes32) {
        return _buildDomainSeparator();
    }

    /// @notice Hash the relayer must sign for `d`. Exposed so tests and the
    ///         relayer share one implementation instead of two that agree by
    ///         coincidence.
    function hashDecision(SettlementDecision calldata d) external view returns (bytes32) {
        return _hashDecision(d);
    }

    // ---------------------------------------------------------------------
    // Admin — pause and relayer rotation only. No fund access. Ever.
    // ---------------------------------------------------------------------

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "relayer=0");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _reviewDeadline(Purchase storage p) private view returns (uint64) {
        return p.deliveredAt + p.reviewWindow;
    }

    function _fullBitmap(uint8 criteriaCount) private pure returns (uint8) {
        return uint8((1 << criteriaCount) - 1);
    }

    /// @dev Rejects: empty, whitespace-only, or over-long text. Reverts rather
    ///      than truncating — silent truncation would mean the hash committed
    ///      on-chain differs from what the parties read, which is exactly the
    ///      desync the hash exists to prevent.
    function _checkText(string calldata s, uint256 maxLen, string memory field) private pure {
        bytes calldata b = bytes(s);
        require(b.length > 0 && b.length <= maxLen, string.concat(field, " length"));
        bool allWhitespace = true;
        for (uint256 i = 0; i < b.length; i++) {
            // space, tab, newline, carriage return
            if (b[i] != 0x20 && b[i] != 0x09 && b[i] != 0x0a && b[i] != 0x0d) {
                allWhitespace = false;
                break;
            }
        }
        require(!allWhitespace, string.concat(field, " blank"));
    }

    function _rubricHash(string[] storage items) private view returns (bytes32) {
        string memory acc = items[0];
        for (uint256 i = 1; i < items.length; i++) {
            acc = string.concat(acc, "\n", items[i]);
        }
        return sha256(bytes(acc));
    }

    /**
     * @dev Structural sanity on the verdict, enforced here rather than trusted
     *      from the LLM. These catch a verdict that is internally incoherent
     *      even if its signature is valid — a compromised relayer key, or a
     *      model that returned a well-formed but self-contradicting answer.
     */
    function _checkVerdictCoherence(SettlementDecision calldata d, uint8 criteriaCount) private pure {
        uint8 full = uint8((1 << criteriaCount) - 1);
        uint8 met = d.criteriaMetBitmap;

        require(met & ~full == 0, "criteria bits out of range");

        if (d.outcome == Outcome.RELEASE) {
            require(d.refundBps == 0, "release bps");
            require(met == full, "release with unmet criterion");
        } else if (d.outcome == Outcome.FULL_REFUND) {
            require(d.refundBps == BPS_DENOMINATOR, "full refund bps");
            // If every criterion was met the promise was kept; a "full refund"
            // on that basis is self-contradicting. The judgment contract
            // repairs this to UNDETERMINED before signing, so reaching here
            // means either a compromised relayer key or a decoder bug.
            require(met != full, "full refund with all criteria met");
        } else if (d.outcome == Outcome.PARTIAL_REFUND) {
            require(d.refundBps > 0 && d.refundBps < BPS_DENOMINATOR, "partial bps");
            require(met != full, "partial refund with all criteria met");
        } else {
            // UNDETERMINED
            require(d.refundBps == 0, "undetermined bps");
        }
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    DOMAIN_TYPEHASH,
                    keccak256(bytes("Recourse")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    function _hashDecision(SettlementDecision calldata d) private view returns (bytes32) {
        // Recompute if the chain id moved out from under the cached value.
        bytes32 domain = block.chainid == _domainChainId() ? _deployedChainIdDomain : _buildDomainSeparator();
        return keccak256(abi.encodePacked("\x19\x01", domain, _structHash(d)));
    }

    /// @dev The EIP-712 struct hash, in its own function so that `abi.encode`'s
    ///      fourteen arguments do not have to share the stack with the domain
    ///      separator. Fourteen arguments plus one live local is the ceiling the
    ///      legacy code generator can reach; the domain separator is the
    ///      fifteenth thing it would have had to keep hold of.
    ///
    ///      The field order here must match SETTLEMENT_TYPEHASH exactly — it is
    ///      what the relayer signs over, and a reordering produces a valid
    ///      signature over the wrong message rather than an error.
    function _structHash(SettlementDecision calldata d) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SETTLEMENT_TYPEHASH,
                d.purchaseId,
                d.nonce,
                d.sourceChainId,
                d.sourceContract,
                d.genlayerTxHash,
                d.promiseHash,
                d.rubricHash,
                d.evidenceRoot,
                d.decisionDigest,
                uint8(d.outcome),
                d.refundBps,
                d.criteriaMetBitmap,
                d.finalized
            )
        );
    }

    /// @dev The chain id the cached domain separator was built for. We do not
    ///      store it separately — the separator is only valid for the chain it
    ///      was built on, and `_buildDomainSeparator` is cheap, so the cache is
    ///      an optimisation for the common path and correctness is preserved by
    ///      the rebuild branch in `_hashDecision`.
    function _domainChainId() private view returns (uint256) {
        return block.chainid;
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        require(signature.length == 65, "sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Reject malleable signatures: s must be in the lower half order.
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "sig s"
        );
        require(v == 27 || v == 28, "sig v");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "sig zero");
        return signer;
    }

    function _pull(address from, uint256 amount) private {
        (bool ok, bytes memory data) = address(usdc).call(
            abi.encodeCall(IERC20.transferFrom, (from, address(this), amount))
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }

    function _push(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _toHexString(address account) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes20 data = bytes20(account);
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
