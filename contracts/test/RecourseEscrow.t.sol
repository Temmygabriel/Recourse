// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseEscrow} from "../src/RecourseEscrow.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {HashVectors} from "./HashVectors.generated.sol";

/// @notice The escrow is the only thing standing between a relayer bug and
///         someone's money, so the attack paths are first-class cases here, not
///         an afterthought bolted on after the happy path.
///
/// @dev Where a test asserts a *specific* revert string, that string is part of
///      the ordering contract of `settle()`. If a check moves, the test that
///      names it fails — which is the point. Tests that only care that
///      something was rejected use a bare `expectRevert()`.
///
/// @dev Criterion bitmaps are written in **hex**, because Solidity has no binary
///      literal — `0b011` does not compile. The mapping is direct: bit `i` of
///      the low nibble means criterion `i`, so 3 criteria span `0x0`–`0x7` and
///      4 criteria span `0x0`–`0xf`. `0x7` is all three met, `0x3` is the first
///      two, `0x5` is the first and third. Spelled out once here so the call
///      sites below do not each need a comment.
contract RecourseEscrowTest is Test {
    MockUSDC usdc;
    RecourseEscrow escrow;

    uint256 constant RELAYER_PK = 0xA11CE;
    uint256 constant IMPOSTER_PK = 0xB0B;
    uint256 constant NEW_RELAYER_PK = 0x5E1;

    /// @dev secp256k1 group order, for building the high-`s` variant.
    uint256 constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    address relayer;
    address owner;
    address seller;
    address buyer;
    address stranger;

    uint96 constant PRICE = 100e6; // 100 USDC
    uint16 constant BOND_BPS = 500; // 5% -> 5 USDC
    uint256 constant SOURCE_CHAIN_ID = 61999; // Studionet
    address constant SOURCE_CONTRACT = address(0xC0FFEE);
    uint64 constant REVIEW_WINDOW = 3 days;
    uint64 constant DELIVERY_OFFSET = 7 days;

    string constant PROMISE =
        "Three finished illustrations of the client mascot, delivered as layered source files, ready for print.";
    string constant DELIVERY_NOTES =
        "Uploaded three illustrations at 3000px plus layered source files to the delivery link.";
    string constant DISPUTE_NOTES =
        "Only two of the three illustrations were provided and no layered source files were included.";
    string constant OTHER_DELIVERY_NOTES = "Uploaded a single flat PNG export, no source files.";
    string constant OTHER_DISPUTE_NOTES =
        "One illustration only, and it was a flat export rather than layered source.";

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    function setUp() public {
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        relayer = vm.addr(RELAYER_PK);
        owner = makeAddr("owner");
        seller = makeAddr("seller");
        buyer = makeAddr("buyer");
        stranger = makeAddr("stranger");

        escrow = _newEscrow();

        usdc.mint(buyer, 10_000e6);
        usdc.mint(seller, 1_000e6);

        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _newEscrow() internal returns (RecourseEscrow) {
        return new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, BOND_BPS, owner
        );
    }

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    function _rubric() internal pure returns (string[] memory r) {
        r = new string[](3);
        r[0] = "Three finished illustrations at 3000px wide";
        r[1] = "A mobile-optimised version of each illustration";
        r[2] = "Layered source files handed over";
    }

    /// @dev The rubric hash written out independently of the contract, so a
    ///      failure points at the contract rather than at a helper that mirrors
    ///      the contract's own bug.
    function _expectedRubricHash() internal pure returns (bytes32) {
        string[] memory r = _rubric();
        return sha256(bytes(string.concat(r[0], "\n", r[1], "\n", r[2])));
    }

    function _offerOn(RecourseEscrow e) internal returns (uint256 id) {
        vm.prank(seller);
        id = e.createOffer(
            PRICE, uint64(block.timestamp) + DELIVERY_OFFSET, REVIEW_WINDOW, PROMISE, _rubric()
        );
    }

    function _offer() internal returns (uint256) {
        return _offerOn(escrow);
    }

    function _fundedOn(RecourseEscrow e) internal returns (uint256 id) {
        id = _offerOn(e);
        vm.prank(buyer);
        e.purchase(id);
    }

    function _funded() internal returns (uint256) {
        return _fundedOn(escrow);
    }

    function _deliveredOn(RecourseEscrow e, string memory notes) internal returns (uint256 id) {
        id = _fundedOn(e);
        vm.prank(seller);
        e.submitDelivery(id, notes);
    }

    function _delivered() internal returns (uint256) {
        return _deliveredOn(escrow, DELIVERY_NOTES);
    }

    function _disputedOn(RecourseEscrow e, string memory deliveryNotes, string memory disputeNotes)
        internal
        returns (uint256 id)
    {
        id = _deliveredOn(e, deliveryNotes);
        vm.prank(buyer);
        e.openDispute(id, 0x2, disputeNotes);
    }

    /// @dev A disputed purchase with the default evidence. Criterion index 1 is
    ///      the one in dispute.
    function _disputed() internal returns (uint256) {
        return _disputedOn(escrow, DELIVERY_NOTES, DISPUTE_NOTES);
    }

    // ---------------------------------------------------------------------
    // Decision construction and signing
    // ---------------------------------------------------------------------

    /// @dev Build a decision carrying the escrow's real commitments, so a test
    ///      only has to state the field it is actually varying.
    function _decisionOn(
        RecourseEscrow e,
        uint256 id,
        RecourseEscrow.Outcome outcome,
        uint16 bps,
        uint8 bitmap
    ) internal view returns (RecourseEscrow.SettlementDecision memory d) {
        d = RecourseEscrow.SettlementDecision({
            purchaseId: id,
            nonce: 1,
            sourceChainId: SOURCE_CHAIN_ID,
            sourceContract: SOURCE_CONTRACT,
            genlayerTxHash: keccak256("genlayer-tx"),
            promiseHash: e.promiseHash(id),
            rubricHash: e.rubricHash(id),
            evidenceRoot: e.evidenceRoot(id),
            decisionDigest: keccak256("verdict-payload"),
            outcome: outcome,
            refundBps: bps,
            criteriaMetBitmap: bitmap,
            finalized: true
        });
    }

    function _decision(uint256 id, RecourseEscrow.Outcome outcome, uint16 bps, uint8 bitmap)
        internal
        view
        returns (RecourseEscrow.SettlementDecision memory)
    {
        return _decisionOn(escrow, id, outcome, bps, bitmap);
    }

    /// @dev A decision that settles `id` cleanly as RELEASE.
    function _cleanRelease(uint256 id)
        internal
        view
        returns (RecourseEscrow.SettlementDecision memory)
    {
        return _decision(id, RecourseEscrow.Outcome.RELEASE, 0, 0x7);
    }

    /// @dev Sign with the escrow's own `hashDecision`, so tests and the relayer
    ///      cannot drift onto two hashing implementations that agree by luck.
    function _sigWith(
        RecourseEscrow e,
        RecourseEscrow.SettlementDecision memory d,
        uint256 pk
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.hashDecision(d));
        return abi.encodePacked(r, s, v);
    }

    function _sig(RecourseEscrow.SettlementDecision memory d) internal view returns (bytes memory) {
        return _sigWith(escrow, d, RELAYER_PK);
    }

    function _settle(RecourseEscrow.SettlementDecision memory d) internal {
        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        escrow.settle(d, sig1);
    }

    // =====================================================================
    // The happy path — offer, pay, deliver, accept
    // =====================================================================

    function test_HappyPath_OfferFundDeliverAccept() public {
        uint256 id = _delivered();

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.acceptDelivery(id);

        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE, "seller paid the full price");
        assertEq(usdc.balanceOf(buyer), buyerBefore, "buyer gets nothing back on acceptance");
        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.SETTLED));
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained");
    }

    function test_Offer_PublishesDerivedHashes() public {
        uint256 id = _offer();
        RecourseEscrow.Purchase memory p = escrow.getPurchase(id);

        assertEq(p.seller, seller, "seller recorded");
        assertEq(uint256(p.criteriaCount), 3, "criteria count taken from rubric length");
        assertEq(uint256(p.stage), uint256(RecourseEscrow.Stage.OPEN));
        assertEq(p.promiseText, PROMISE, "promise text stored in full, not just its hash");
        assertEq(p.rubric[0], _rubric()[0], "rubric criterion 0 preserved verbatim");
        assertEq(p.rubric[2], _rubric()[2], "rubric criterion 2 preserved verbatim");
        assertEq(escrow.promiseHash(id), sha256(bytes(PROMISE)), "promise hash derived from text");
        assertEq(escrow.rubricHash(id), _expectedRubricHash(), "rubric hash joins with newline");
    }

    // =====================================================================
    // Verdict outcomes — money and bond both follow docs/DATA_MODEL.md section 6
    // =====================================================================

    function test_Release_PaysSellerAndForfeitsBuyerBond() public {
        uint256 id = _disputed();
        uint96 bond = escrow.disputeBond(PRICE);
        assertEq(uint256(bond), (uint256(PRICE) * BOND_BPS) / 10_000, "bond is 5% of price");

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        _settle(_cleanRelease(id));

        assertEq(
            usdc.balanceOf(seller), sellerBefore + PRICE + bond, "seller: price + forfeited bond"
        );
        assertEq(usdc.balanceOf(buyer), buyerBefore, "buyer: nothing back");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained");
    }

    function test_FullRefund_ReturnsPriceAndBond() public {
        uint256 id = _disputed();
        uint96 bond = escrow.disputeBond(PRICE);

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        _settle(_decision(id, RecourseEscrow.Outcome.FULL_REFUND, 10_000, 0x0));

        assertEq(usdc.balanceOf(buyer), buyerBefore + PRICE + bond, "buyer: price + bond back");
        assertEq(usdc.balanceOf(seller), sellerBefore, "seller: nothing");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained");
    }

    function test_PartialRefund_SplitsPriceAndReturnsBond() public {
        uint256 id = _disputed();
        uint96 bond = escrow.disputeBond(PRICE);

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        _settle(_decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 3_000, 0x5));

        assertEq(usdc.balanceOf(buyer), buyerBefore + (uint256(PRICE) * 3_000) / 10_000 + bond);
        assertEq(usdc.balanceOf(seller), sellerBefore + (uint256(PRICE) * 7_000) / 10_000);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained");
    }

    /// @dev The policy decision documented in DATA_MODEL section 6: an
    ///      inconclusive judgment does not establish a breach, so the seller is
    ///      paid — but the buyer was not shown to be acting in bad faith, so the
    ///      bond comes back.
    function test_Undetermined_PaysSellerButReturnsBond() public {
        uint256 id = _disputed();
        uint96 bond = escrow.disputeBond(PRICE);

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        _settle(_decision(id, RecourseEscrow.Outcome.UNDETERMINED, 0, 0x2));

        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE, "seller: price only");
        assertEq(usdc.balanceOf(buyer), buyerBefore + bond, "buyer: bond returned");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained");
    }

    /// @dev A zero bond bps is impossible (the constructor floors it at 1%), but
    ///      a price small enough to round the bond to zero is not — exercising
    ///      that path confirms `_push` skipping a zero transfer does not change
    ///      the split.
    function test_DustPrice_BondRoundsToZeroAndSplitStillExact() public {
        uint96 price = 1; // 1 micro-USDC; 1% of it rounds to 0

        vm.prank(seller);
        uint256 id = escrow.createOffer(
            price, uint64(block.timestamp) + DELIVERY_OFFSET, REVIEW_WINDOW, PROMISE, _rubric()
        );
        vm.prank(buyer);
        escrow.purchase(id);
        vm.prank(seller);
        escrow.submitDelivery(id, DELIVERY_NOTES);
        vm.prank(buyer);
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);

        assertEq(uint256(escrow.disputeBond(price)), 0, "bond rounds to zero at dust prices");

        _settle(_decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 5_000, 0x3));

        assertEq(usdc.balanceOf(address(escrow)), 0, "no dust stranded at dust prices");
    }

    /// @dev The split must always sum to exactly the price. Integer-division dust
    ///      would otherwise be stranded permanently — the escrow is not
    ///      upgradeable and has no admin withdrawal.
    function testFuzz_PartialRefundSplitLeavesNoDustInEscrow(uint16 bps) public {
        bps = uint16(bound(bps, 1, 9_999));
        uint256 id = _disputed();

        _settle(_decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, bps, 0x3));

        assertEq(usdc.balanceOf(address(escrow)), 0, "no dust may be stranded");
    }

    /// @dev Odd prices are where the rounding of `price * bps / 10000` shows up.
    function testFuzz_PartialRefundSplitIsExact(uint96 price, uint16 bps) public {
        // Bounded by what the fixture can actually fund, not by the type. The
        // buyer is minted 10,000 USDC in setUp and `purchase` pulls the price
        // plus a 5% bond, so a wider bound makes `purchase` revert with
        // "transferFrom failed" — a funding failure dressed up as a split
        // failure. The property under test is the arithmetic, so the range only
        // has to be one the escrow can actually reach.
        price = uint96(bound(price, 1, 9_000e6));
        bps = uint16(bound(bps, 1, 9_999));

        vm.prank(seller);
        uint256 id = escrow.createOffer(
            price, uint64(block.timestamp) + DELIVERY_OFFSET, REVIEW_WINDOW, PROMISE, _rubric()
        );
        vm.prank(buyer);
        escrow.purchase(id);
        vm.prank(seller);
        escrow.submitDelivery(id, DELIVERY_NOTES);
        vm.prank(buyer);
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);

        uint256 buyerBefore = usdc.balanceOf(buyer);
        uint256 sellerBefore = usdc.balanceOf(seller);

        _settle(_decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, bps, 0x3));

        uint256 refund = (uint256(price) * bps) / 10_000;
        assertEq(usdc.balanceOf(buyer), buyerBefore + refund + escrow.disputeBond(price));
        assertEq(usdc.balanceOf(seller), sellerBefore + uint256(price) - refund);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // =====================================================================
    // Replay and double-execution (build spec 4.6 — P0)
    // =====================================================================

    function test_Replay_SameSignedDecisionRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.FULL_REFUND, 10_000, 0x0);
        bytes memory sig = _sig(d);

        vm.prank(relayer);
        escrow.settle(d, sig);

        // Byte-identical resubmission.
        vm.prank(relayer);
        vm.expectRevert("not disputed");
        escrow.settle(d, sig);
    }

    function test_Replay_FreshNonceOnSettledPurchaseRejected() public {
        uint256 id = _disputed();
        _settle(_decision(id, RecourseEscrow.Outcome.FULL_REFUND, 10_000, 0x0));

        RecourseEscrow.SettlementDecision memory d2 = _cleanRelease(id);
        d2.nonce = 2;

        bytes memory sig1 = _sig(d2);
        vm.prank(relayer);
        vm.expectRevert("not disputed");
        escrow.settle(d2, sig1);
    }

    function test_Replay_NonceCannotBeReusedAcrossPurchases() public {
        uint256 first = _disputedOn(escrow, DELIVERY_NOTES, DISPUTE_NOTES);
        uint256 second = _disputedOn(escrow, OTHER_DELIVERY_NOTES, OTHER_DISPUTE_NOTES);

        _settle(_cleanRelease(first));

        // Every decision the fixture builds carries nonce 1, so this is the
        // cross-purchase replay: a second, genuinely different verdict carrying
        // a nonce that has already been spent.
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(second);
        assertEq(d.nonce, 1, "fixture assumes the default nonce");

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("nonce used");
        escrow.settle(d, sig1);

        assertTrue(escrow.nonceUsed(1), "nonce ledger is global, not per-purchase");
    }

    // =====================================================================
    // Relayer authorisation (build spec 4.1 / 4.7 — P0)
    // =====================================================================

    function test_Settle_WrongSignerRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        // Right caller, signature from a key that is not the relayer.
        bytes memory sig1 = _sigWith(escrow, d, IMPOSTER_PK);
        vm.prank(relayer);
        vm.expectRevert("bad relayer signature");
        escrow.settle(d, sig1);
    }

    /// @dev A valid relayer signature is necessary but not sufficient — the
    ///      caller must be the relayer too, so a decision observed in the
    ///      mempool cannot be pushed by a third party.
    function test_Settle_StrangerWithValidSignatureRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        bytes memory sig1 = _sig(d);
        vm.prank(stranger);
        vm.expectRevert("not relayer");
        escrow.settle(d, sig1);
    }

    /// @dev Swap the verdict after signing — the classic relay-layer attack. The
    ///      mutated decision is still internally coherent, so the signature
    ///      check is the only thing that can catch it.
    function test_Settle_TamperedOutcomeRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 3_000, 0x3);
        bytes memory sig = _sig(d);

        d.outcome = RecourseEscrow.Outcome.FULL_REFUND;
        d.refundBps = 10_000; // coherent with FULL_REFUND at bitmap 0x3

        vm.prank(relayer);
        vm.expectRevert("bad relayer signature");
        escrow.settle(d, sig);
    }

    function test_Settle_TamperedRefundBpsRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 1_000, 0x3);
        bytes memory sig = _sig(d);

        d.refundBps = 9_000; // inflate the buyer's refund; still coherent

        vm.prank(relayer);
        vm.expectRevert("bad relayer signature");
        escrow.settle(d, sig);
    }

    function test_Settle_TamperedNonceRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        bytes memory sig = _sig(d);

        d.nonce = 42;

        vm.prank(relayer);
        vm.expectRevert("bad relayer signature");
        escrow.settle(d, sig);
    }

    function test_Settle_MalformedSignatureRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        vm.prank(relayer);
        vm.expectRevert("sig length");
        escrow.settle(d, hex"deadbeef");
    }

    /// @dev Malleability guard: `s` must be in the lower half of the curve
    ///      order. The high-`s` variant of a valid signature is that same
    ///      signature by another name, so accepting it would give one decision
    ///      two valid encodings.
    function test_Settle_HighSSignatureRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_PK, escrow.hashDecision(d));
        bytes32 flipped = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        vm.prank(relayer);
        vm.expectRevert("sig s");
        escrow.settle(d, abi.encodePacked(r, flipped, flippedV));
    }

    function test_Settle_WrongVRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(RELAYER_PK, escrow.hashDecision(d));

        vm.prank(relayer);
        vm.expectRevert("sig v");
        escrow.settle(d, abi.encodePacked(r, s, uint8(v + 2)));
    }

    function test_Settle_SignatureIsNotReusableAfterRelayerRotation() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        bytes memory sig = _sig(d);

        address newRelayer = vm.addr(NEW_RELAYER_PK);
        vm.prank(owner);
        escrow.setRelayer(newRelayer);

        // A signature collected before the rotation must not survive it.
        vm.prank(relayer);
        vm.expectRevert("not relayer");
        escrow.settle(d, sig);
    }

    // =====================================================================
    // Decision context verification (build spec section 3)
    // =====================================================================

    function test_Settle_NotFinalizedRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.finalized = false;

        // Signed *with* finalized=false, so this is the trust boundary firing
        // and not the signature check.
        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("not finalized");
        escrow.settle(d, sig1);
    }

    function test_Settle_WrongSourceChainRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.sourceChainId = 61997; // studio-dev, a different network

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("wrong source chain");
        escrow.settle(d, sig1);
    }

    function test_Settle_WrongSourceContractRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.sourceContract = address(0xBAD);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("wrong source contract");
        escrow.settle(d, sig1);
    }

    function test_Settle_MismatchedPromiseHashRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.promiseHash = keccak256("a different promise than the buyer agreed to");

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("promise mismatch");
        escrow.settle(d, sig1);
    }

    function test_Settle_MismatchedRubricHashRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.rubricHash = keccak256("a rubric the seller never published");

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("rubric mismatch");
        escrow.settle(d, sig1);
    }

    function test_Settle_MismatchedEvidenceRootRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.evidenceRoot = keccak256("evidence the chain never saw");

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("evidence mismatch");
        escrow.settle(d, sig1);
    }

    /// @dev A verdict genuinely produced for purchase 2, relabelled as purchase
    ///      1. Both exist and both are DISPUTED, so the evidence commitment is
    ///      the only thing distinguishing them.
    function test_Settle_CrossPurchaseDecisionRejected() public {
        _disputedOn(escrow, DELIVERY_NOTES, DISPUTE_NOTES);
        uint256 second = _disputedOn(escrow, OTHER_DELIVERY_NOTES, OTHER_DISPUTE_NOTES);

        RecourseEscrow.SettlementDecision memory d = _cleanRelease(second);
        d.purchaseId = 1;

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("evidence mismatch");
        escrow.settle(d, sig1);
    }

    /// @dev Identical evidence on two purchases is the case the purchase id
    ///      itself has to catch, since no hash distinguishes them. Relabelling a
    ///      decision for purchase 2 as purchase 1 is not detectable — and is
    ///      also harmless, because both would move the same money. What actually
    ///      protects the second purchase is the nonce ledger.
    function test_Settle_RelabelledPurchaseIsHarmlessButNonceStillGuards() public {
        uint256 first = _disputedOn(escrow, DELIVERY_NOTES, DISPUTE_NOTES);
        uint256 second = _disputedOn(escrow, DELIVERY_NOTES, DISPUTE_NOTES);
        assertTrue(first != second, "two distinct purchases");

        RecourseEscrow.SettlementDecision memory d = _cleanRelease(second);

        // `second` is legitimate; relabelling it as `first` is not detectable by
        // hash, and would be harmless anyway (same money movement) — but the
        // nonce is spent only once, so the second settlement of either id fails.
        d.purchaseId = first;

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        escrow.settle(d, sig1); // settles `first` as claimed

        assertEq(uint256(escrow.getPurchase(first).stage), uint256(RecourseEscrow.Stage.SETTLED));
        assertEq(uint256(escrow.getPurchase(second).stage), uint256(RecourseEscrow.Stage.DISPUTED));

        // `second` still needs its own decision, and it cannot reuse nonce 1.
        RecourseEscrow.SettlementDecision memory d2 = _cleanRelease(second);
        d2.nonce = 2;
        _settle(d2);
        assertEq(uint256(escrow.getPurchase(second).stage), uint256(RecourseEscrow.Stage.SETTLED));
    }

    function test_Settle_UnknownPurchaseRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);
        d.purchaseId = 9_999;

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert();
        escrow.settle(d, sig1);
    }

    // =====================================================================
    // Verdict coherence — a valid signature is not enough
    // =====================================================================

    function test_Settle_ReleaseWithUnmetCriterionRejected() public {
        uint256 id = _disputed();
        // Claims release while its own bitmap admits a criterion failed.
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.RELEASE, 0, 0x6);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("release with unmet criterion");
        escrow.settle(d, sig1);
    }

    function test_Settle_ReleaseWithNonZeroBpsRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.RELEASE, 500, 0x7);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("release bps");
        escrow.settle(d, sig1);
    }

    /// @dev A full refund while claiming every criterion was met is
    ///      self-contradicting. The GenLayer contract repairs exactly this to
    ///      UNDETERMINED before signing, so reaching here means a compromised
    ///      relayer key or a decoder bug — and the escrow refuses either.
    function test_Settle_FullRefundWithAllCriteriaMetRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.FULL_REFUND, 10_000, 0x7);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("full refund with all criteria met");
        escrow.settle(d, sig1);
    }

    function test_Settle_FullRefundWithPartialBpsRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.FULL_REFUND, 5_000, 0x0);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("full refund bps");
        escrow.settle(d, sig1);
    }

    function test_Settle_PartialRefundWithAllCriteriaMetRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 3_000, 0x7);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("partial refund with all criteria met");
        escrow.settle(d, sig1);
    }

    function test_Settle_PartialRefundWithZeroBpsRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 0, 0x3);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("partial bps");
        escrow.settle(d, sig1);
    }

    function test_Settle_PartialRefundWithFullBpsRejected() public {
        uint256 id = _disputed();
        // Should have been FULL_REFUND. Claiming PARTIAL at 100% would leave the
        // seller nothing while dodging the full-refund coherence rule.
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.PARTIAL_REFUND, 10_000, 0x3);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("partial bps");
        escrow.settle(d, sig1);
    }

    function test_Settle_UndeterminedWithNonZeroBpsRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.UNDETERMINED, 2_500, 0x2);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("undetermined bps");
        escrow.settle(d, sig1);
    }

    /// @dev Only 3 criteria exist, so bit 3 is not addressable.
    function test_Settle_CriteriaBitmapOutOfRangeRejected() public {
        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d =
            _decision(id, RecourseEscrow.Outcome.RELEASE, 0, 0xf);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("criteria bits out of range");
        escrow.settle(d, sig1);
    }

    /// @dev The bitmap's upper bits must be rejected for every outcome, not just
    ///      RELEASE — the range check is not inside any one branch.
    function test_Settle_BitmapOutOfRangeRejectedForEveryOutcome() public {
        uint256 id = _disputed();

        RecourseEscrow.Outcome[3] memory outcomes = [
            RecourseEscrow.Outcome.PARTIAL_REFUND,
            RecourseEscrow.Outcome.FULL_REFUND,
            RecourseEscrow.Outcome.UNDETERMINED
        ];
        uint16[3] memory bpss = [uint16(3_000), uint16(10_000), uint16(0)];

        for (uint256 i = 0; i < outcomes.length; i++) {
            RecourseEscrow.SettlementDecision memory d = _decision(id, outcomes[i], bpss[i], 0x8);
            bytes memory sig1 = _sig(d);
            vm.prank(relayer);
            vm.expectRevert("criteria bits out of range");
            escrow.settle(d, sig1);
        }
    }

    // =====================================================================
    // State machine — illegal transitions
    // =====================================================================

    function test_Settle_OnUndisputedPurchaseRejected() public {
        uint256 id = _delivered();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("not disputed");
        escrow.settle(d, sig1);
    }

    function test_Settle_OnFundedPurchaseRejected() public {
        uint256 id = _funded();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("not disputed");
        escrow.settle(d, sig1);
    }

    function test_Settle_OnOfferNeverPurchasedRejected() public {
        uint256 id = _offer();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("not disputed");
        escrow.settle(d, sig1);
    }

    function test_Seller_CannotBuyOwnOffer() public {
        uint256 id = _offer();
        vm.prank(seller);
        vm.expectRevert("seller cannot buy");
        escrow.purchase(id);
    }

    function test_Purchase_TwiceRejected() public {
        uint256 id = _funded();
        vm.prank(stranger);
        vm.expectRevert("not open");
        escrow.purchase(id);
    }

    function test_Purchase_AfterDeadlineRejected() public {
        uint256 id = _offer();
        vm.warp(block.timestamp + DELIVERY_OFFSET + 1);

        vm.prank(buyer);
        vm.expectRevert("deadline past");
        escrow.purchase(id);
    }

    function test_Accept_ByNonBuyerRejected() public {
        uint256 id = _delivered();
        vm.prank(stranger);
        vm.expectRevert("not buyer");
        escrow.acceptDelivery(id);
    }

    function test_Accept_OnFundedPurchaseRejected() public {
        uint256 id = _funded();
        vm.prank(buyer);
        vm.expectRevert("not delivered");
        escrow.acceptDelivery(id);
    }

    function test_Dispute_ByNonBuyerRejected() public {
        uint256 id = _delivered();
        vm.prank(stranger);
        vm.expectRevert("not buyer");
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);
    }

    function test_Deliver_AfterDeadlineRejected() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + DELIVERY_OFFSET + 1);

        vm.prank(seller);
        vm.expectRevert("delivery late");
        escrow.submitDelivery(id, DELIVERY_NOTES);
    }

    function test_Deliver_ByNonSellerRejected() public {
        uint256 id = _funded();
        vm.prank(stranger);
        vm.expectRevert("not seller");
        escrow.submitDelivery(id, DELIVERY_NOTES);
    }

    function test_Deliver_TwiceRejected() public {
        uint256 id = _delivered();
        vm.prank(seller);
        vm.expectRevert("not funded");
        escrow.submitDelivery(id, DELIVERY_NOTES);
    }

    function test_CancelOffer_UnpurchasedWorks() public {
        uint256 id = _offer();
        vm.prank(seller);
        escrow.cancelOffer(id);
        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.NONE));
    }

    function test_CancelOffer_ByNonSellerRejected() public {
        uint256 id = _offer();
        vm.prank(stranger);
        vm.expectRevert("not seller");
        escrow.cancelOffer(id);
    }

    function test_CancelOffer_AfterPurchaseRejected() public {
        uint256 id = _funded();
        vm.prank(seller);
        vm.expectRevert("not open");
        escrow.cancelOffer(id);
    }

    // =====================================================================
    // Timeouts — nobody's funds are ever stranded
    // =====================================================================

    function test_ReviewTimeout_ReleasesToSellerAfterWindow() public {
        uint256 id = _delivered();
        uint256 sellerBefore = usdc.balanceOf(seller);

        vm.expectRevert("window open");
        escrow.claimReviewTimeout(id);

        vm.warp(block.timestamp + REVIEW_WINDOW + 1);
        escrow.claimReviewTimeout(id); // permissionless on purpose

        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// @dev Permissionless does not mean redirectable: the destination is fixed
    ///      by the state machine, not chosen by the caller.
    function test_ReviewTimeout_CallerCannotRedirectFunds() public {
        uint256 id = _delivered();
        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 strangerBefore = usdc.balanceOf(stranger);

        vm.warp(block.timestamp + REVIEW_WINDOW + 1);
        vm.prank(stranger);
        escrow.claimReviewTimeout(id);

        assertEq(usdc.balanceOf(stranger), strangerBefore, "caller takes nothing");
        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE);
    }

    function test_Dispute_AfterReviewWindowRejected() public {
        uint256 id = _delivered();
        vm.warp(block.timestamp + REVIEW_WINDOW + 1);

        vm.prank(buyer);
        vm.expectRevert("review window closed");
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);
    }

    function test_Accept_AfterReviewWindowRejected() public {
        uint256 id = _delivered();
        vm.warp(block.timestamp + REVIEW_WINDOW + 1);

        vm.prank(buyer);
        vm.expectRevert("review window closed");
        escrow.acceptDelivery(id);
    }

    /// @dev The review window runs from delivery, not from purchase: a late
    ///      delivery must not shorten the buyer's review time.
    function test_ReviewDeadline_RunsFromDeliveryNotPurchase() public {
        uint256 id = _funded();
        vm.warp(block.timestamp + DELIVERY_OFFSET - 1);
        uint64 deliveredAt = uint64(block.timestamp);

        vm.prank(seller);
        escrow.submitDelivery(id, DELIVERY_NOTES);

        assertEq(escrow.reviewDeadline(id), deliveredAt + REVIEW_WINDOW);
    }

    function test_DeadlineRefund_FullRefundWhenSellerNeverDelivers() public {
        uint256 id = _funded();
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.expectRevert("deadline not passed");
        escrow.claimDeadlineRefund(id);

        vm.warp(block.timestamp + DELIVERY_OFFSET + 1);
        escrow.claimDeadlineRefund(id);

        assertEq(usdc.balanceOf(buyer), buyerBefore + PRICE, "buyer made whole, no dispute needed");
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_DeadlineRefund_UnavailableOnceDelivered() public {
        uint256 id = _delivered();
        vm.warp(block.timestamp + DELIVERY_OFFSET + 1);

        vm.expectRevert("not funded");
        escrow.claimDeadlineRefund(id);
    }

    // =====================================================================
    // Input validation (build spec 4.2 — bounds enforced at every layer)
    // =====================================================================

    function test_CreateOffer_TooFewCriteriaRejected() public {
        string[] memory r = new string[](1);
        r[0] = "Only one criterion";

        vm.prank(seller);
        vm.expectRevert("criteria count");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r);
    }

    function test_CreateOffer_TooManyCriteriaRejected() public {
        string[] memory r = new string[](5);
        for (uint256 i = 0; i < 5; i++) {
            r[i] = "criterion";
        }

        vm.prank(seller);
        vm.expectRevert("criteria count");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r);
    }

    function test_CreateOffer_TwoCriteriaAccepted() public {
        string[] memory r = new string[](2);
        r[0] = "First criterion";
        r[1] = "Second criterion";

        vm.prank(seller);
        uint256 id = escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r
        );
        assertEq(uint256(escrow.getPurchase(id).criteriaCount), 2);
    }

    function test_CreateOffer_FourCriteriaAccepted() public {
        string[] memory r = new string[](4);
        for (uint256 i = 0; i < 4; i++) {
            r[i] = "criterion";
        }

        vm.prank(seller);
        uint256 id = escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r
        );
        assertEq(uint256(escrow.getPurchase(id).criteriaCount), 4);
    }

    function test_CreateOffer_BlankPromiseRejected() public {
        vm.prank(seller);
        vm.expectRevert("promiseText blank");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, "   ", _rubric());
    }

    function test_CreateOffer_WhitespaceOnlyPromiseRejected() public {
        vm.prank(seller);
        vm.expectRevert("promiseText blank");
        escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, "  \n\t  ", _rubric()
        );
    }

    function test_CreateOffer_EmptyPromiseRejected() public {
        vm.prank(seller);
        vm.expectRevert("promiseText length");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, "", _rubric());
    }

    /// @dev Reverting rather than truncating matters: a truncated promise would
    ///      mean the on-chain hash describes different text from the text the
    ///      parties read and the judgment contract evaluates.
    function test_CreateOffer_OverlongPromiseRejectedNotTruncated() public {
        vm.prank(seller);
        vm.expectRevert("promiseText length");
        escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, _repeat("a", 501), _rubric()
        );
    }

    function test_CreateOffer_PromiseAtExactLimitAccepted() public {
        vm.prank(seller);
        escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, _repeat("a", 500), _rubric()
        );
        assertEq(escrow.purchaseCount(), 1);
    }

    function test_CreateOffer_OverlongRubricItemRejected() public {
        string[] memory r = _rubric();
        r[0] = _repeat("b", 201);

        vm.prank(seller);
        vm.expectRevert("rubric item length");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r);
    }

    function test_CreateOffer_RubricItemAtExactLimitAccepted() public {
        string[] memory r = _rubric();
        r[0] = _repeat("b", 200);

        vm.prank(seller);
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, r);
        assertEq(escrow.purchaseCount(), 1);
    }

    function test_CreateOffer_PastDeadlineRejected() public {
        vm.prank(seller);
        vm.expectRevert("deadline past");
        escrow.createOffer(PRICE, uint64(block.timestamp), REVIEW_WINDOW, PROMISE, _rubric());
    }

    function test_CreateOffer_ZeroPriceRejected() public {
        vm.prank(seller);
        vm.expectRevert("price=0");
        escrow.createOffer(0, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, _rubric());
    }

    function test_CreateOffer_ReviewWindowTooShortRejected() public {
        vm.prank(seller);
        vm.expectRevert("review window range");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), 1 minutes, PROMISE, _rubric());
    }

    function test_CreateOffer_ReviewWindowTooLongRejected() public {
        vm.prank(seller);
        vm.expectRevert("review window range");
        escrow.createOffer(PRICE, uint64(block.timestamp + 1 days), 31 days, PROMISE, _rubric());
    }

    function test_Dispute_NoCriterionSelectedRejected() public {
        uint256 id = _delivered();
        vm.prank(buyer);
        vm.expectRevert("no criterion");
        escrow.openDispute(id, 0, DISPUTE_NOTES);
    }

    function test_Dispute_CriterionOutOfRangeRejected() public {
        uint256 id = _delivered();
        vm.prank(buyer);
        vm.expectRevert("criterion out of range");
        escrow.openDispute(id, 0x8, DISPUTE_NOTES); // bit 3; only 3 criteria
    }

    function test_Dispute_OverlongNotesRejected() public {
        uint256 id = _delivered();
        vm.prank(buyer);
        vm.expectRevert("disputeNotes length");
        escrow.openDispute(id, 0x1, _repeat("c", 2_001));
    }

    function test_Dispute_BlankNotesRejected() public {
        uint256 id = _delivered();
        vm.prank(buyer);
        vm.expectRevert("disputeNotes blank");
        escrow.openDispute(id, 0x1, "   ");
    }

    function test_Deliver_BlankNotesRejected() public {
        uint256 id = _funded();
        vm.prank(seller);
        vm.expectRevert("deliveryNotes blank");
        escrow.submitDelivery(id, "   ");
    }

    function test_Deliver_OverlongNotesRejected() public {
        uint256 id = _funded();
        vm.prank(seller);
        vm.expectRevert("deliveryNotes length");
        escrow.submitDelivery(id, _repeat("d", 2_001));
    }

    // =====================================================================
    // Bond economics (build spec 4.5 — griefing)
    // =====================================================================

    function test_Dispute_RequiresBondTransfer() public {
        uint256 id = _delivered();
        uint96 bond = escrow.disputeBond(PRICE);
        uint256 buyerBefore = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);

        assertEq(usdc.balanceOf(buyer), buyerBefore - bond, "buyer posted the bond");
        assertEq(usdc.balanceOf(address(escrow)), PRICE + bond, "escrow holds price and bond");
    }

    function test_Dispute_WithoutBondApprovalReverts() public {
        address brokeBuyer = makeAddr("brokeBuyer");
        usdc.mint(brokeBuyer, PRICE);

        vm.prank(brokeBuyer);
        usdc.approve(address(escrow), type(uint256).max);

        uint256 id = _offer();
        vm.prank(brokeBuyer);
        escrow.purchase(id);
        vm.prank(seller);
        escrow.submitDelivery(id, DELIVERY_NOTES);

        // Every USDC the buyer had went into escrow, so the bond cannot be pulled.
        vm.prank(brokeBuyer);
        vm.expectRevert();
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);

        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.DELIVERED));
    }

    function test_Dispute_CannotBeOpenedTwice() public {
        uint256 id = _disputed();

        vm.prank(buyer);
        vm.expectRevert("not delivered");
        escrow.openDispute(id, 0x1, DISPUTE_NOTES);
    }

    function test_Purchase_WithoutApprovalReverts() public {
        uint256 id = _offer();
        address noAllowance = makeAddr("noAllowance");
        usdc.mint(noAllowance, PRICE);

        vm.prank(noAllowance);
        vm.expectRevert();
        escrow.purchase(id);
    }

    function test_Purchase_WithInsufficientBalanceReverts() public {
        uint256 id = _offer();
        address poor = makeAddr("poor");
        usdc.mint(poor, PRICE - 1);

        vm.prank(poor);
        usdc.approve(address(escrow), type(uint256).max);

        vm.prank(poor);
        vm.expectRevert();
        escrow.purchase(id);

        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.OPEN));
    }

    // =====================================================================
    // Admin — pause and relayer rotation only, and neither touches the money
    // =====================================================================

    function test_Pause_BlocksPurchasesAndSettlements() public {
        uint256 open = _offer();
        uint256 disputed = _disputed();

        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        vm.expectRevert("paused");
        escrow.purchase(open);

        RecourseEscrow.SettlementDecision memory d = _cleanRelease(disputed);
        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("paused");
        escrow.settle(d, sig1);
    }

    function test_Pause_BlocksNewOffersAndDisputes() public {
        uint256 delivered = _delivered();

        vm.prank(owner);
        escrow.pause();

        vm.prank(seller);
        vm.expectRevert("paused");
        escrow.createOffer(
            PRICE, uint64(block.timestamp + 1 days), REVIEW_WINDOW, PROMISE, _rubric()
        );

        vm.prank(buyer);
        vm.expectRevert("paused");
        escrow.openDispute(delivered, 0x1, DISPUTE_NOTES);
    }

    /// @dev Pausing must not trap money already in flight. Every path that
    ///      returns funds on terms the contract already committed to stays open.
    function test_Pause_DoesNotBlockAcceptOrRefundPaths() public {
        uint256 delivered = _delivered();
        uint256 funded = _funded();

        vm.prank(owner);
        escrow.pause();

        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(buyer);
        escrow.acceptDelivery(delivered);
        assertEq(usdc.balanceOf(seller), sellerBefore + PRICE, "accept works while paused");

        uint256 buyerBefore = usdc.balanceOf(buyer);
        vm.warp(block.timestamp + DELIVERY_OFFSET + 1);
        escrow.claimDeadlineRefund(funded);
        assertEq(usdc.balanceOf(buyer), buyerBefore + PRICE, "deadline refund works while paused");
    }

    function test_Unpause_RestoresOperation() public {
        uint256 id = _offer();

        vm.startPrank(owner);
        escrow.pause();
        escrow.unpause();
        vm.stopPrank();

        vm.prank(buyer);
        escrow.purchase(id);
        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.FUNDED));
    }

    function test_Pause_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert("not owner");
        escrow.pause();
    }

    function test_Unpause_OnlyOwner() public {
        vm.prank(owner);
        escrow.pause();

        vm.prank(stranger);
        vm.expectRevert("not owner");
        escrow.unpause();
    }

    function test_SetRelayer_RotatesSigningKey() public {
        address newRelayer = vm.addr(NEW_RELAYER_PK);

        vm.prank(owner);
        escrow.setRelayer(newRelayer);

        uint256 id = _disputed();
        RecourseEscrow.SettlementDecision memory d = _cleanRelease(id);

        // The old key no longer settles...
        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("not relayer");
        escrow.settle(d, sig1);

        // ...and the new key does.
        bytes memory sig2 = _sigWith(escrow, d, NEW_RELAYER_PK);
        vm.prank(newRelayer);
        escrow.settle(d, sig2);

        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.SETTLED));
    }

    function test_SetRelayer_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert("not owner");
        escrow.setRelayer(stranger);
    }

    function test_SetRelayer_ZeroAddressRejected() public {
        vm.prank(owner);
        vm.expectRevert("relayer=0");
        escrow.setRelayer(address(0));
    }

    function test_TransferOwnership_OnlyOwnerAndTakesEffect() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(stranger);
        vm.expectRevert("not owner");
        escrow.transferOwnership(newOwner);

        vm.prank(owner);
        escrow.transferOwnership(newOwner);

        vm.prank(owner);
        vm.expectRevert("not owner");
        escrow.pause();

        vm.prank(newOwner);
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_TransferOwnership_ZeroAddressRejected() public {
        vm.prank(owner);
        vm.expectRevert("owner=0");
        escrow.transferOwnership(address(0));
    }

    /// @dev Pins the claim in the README and in the contract header: the owner
    ///      has no path to the funds. Every admin function is exercised and the
    ///      escrow's balance is asserted unchanged throughout.
    function test_OwnerHasNoPathToFunds() public {
        uint256 id = _funded();
        uint256 held = usdc.balanceOf(address(escrow));
        assertEq(held, PRICE);

        address newOwner = makeAddr("newOwner");
        vm.startPrank(owner);
        escrow.pause();
        escrow.unpause();
        escrow.setRelayer(relayer);
        escrow.transferOwnership(newOwner);
        vm.stopPrank();

        vm.prank(newOwner);
        escrow.pause();

        assertEq(usdc.balanceOf(address(escrow)), held, "admin calls moved no funds");
        assertEq(uint256(escrow.getPurchase(id).stage), uint256(RecourseEscrow.Stage.FUNDED));
    }

    // =====================================================================
    // Identity, hashing, and the GenLayer purchase key
    // =====================================================================

    function test_DomainSeparator_MatchesEip712Spec() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("Recourse"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.domainSeparator(), expected);
    }

    /// @dev A signature is bound to this escrow on this chain. A second
    ///      deployment with identical configuration, an identical purchase, and
    ///      identical evidence must still reject it — the domain separator is
    ///      the only difference, so this pins that it does the work.
    function test_SignatureIsBoundToThisEscrow() public {
        RecourseEscrow other = _newEscrow();

        vm.prank(buyer);
        usdc.approve(address(other), type(uint256).max);

        uint256 otherId = _disputedOn(other, DELIVERY_NOTES, DISPUTE_NOTES);
        assertEq(otherId, 1, "same purchase id, so the id cannot distinguish them");

        RecourseEscrow.SettlementDecision memory d =
            _decisionOn(other, otherId, RecourseEscrow.Outcome.RELEASE, 0, 0x7);

        // Signed against `escrow`'s domain separator, submitted to `other`.
        bytes memory sig1 = _sig(d);
        vm.prank(relayer);
        vm.expectRevert("bad relayer signature");
        other.settle(d, sig1);
    }

    function test_GenlayerKey_BindsChainEscrowAndPurchase() public {
        uint256 id = _offer();

        // Lowercased deliberately. `genlayerKey` renders the escrow address with
        // the contract's own hex encoder, which emits lowercase, while
        // `vm.toString(address)` renders it EIP-55 checksummed. The key is
        // opaque and both consumers — `genlayerKey()` in relayer/src/escrow.ts
        // and in frontend/src/lib/escrow.ts — obtain it by calling the contract
        // rather than rebuilding the string, so the contract's rendering is the
        // only one that exists and the check has to compare against it.
        assertEq(
            escrow.genlayerKey(id),
            string.concat(
                "recourse:",
                vm.toString(block.chainid),
                ":",
                vm.toLowercase(vm.toString(address(escrow))),
                ":",
                vm.toString(id)
            ),
            "key format must match docs/DATA_MODEL.md section 8"
        );
    }

    function test_GenlayerKey_DiffersPerPurchaseAndPerEscrow() public {
        uint256 first = _offer();
        uint256 second = _offer();

        assertTrue(
            keccak256(bytes(escrow.genlayerKey(first)))
                != keccak256(bytes(escrow.genlayerKey(second))),
            "distinct purchases get distinct keys"
        );

        RecourseEscrow other = _newEscrow();
        assertTrue(
            keccak256(bytes(escrow.genlayerKey(first)))
                != keccak256(bytes(other.genlayerKey(first))),
            "the same purchase id on another escrow is a different key"
        );
    }

    function test_HashesMatchSha256OfText() public {
        uint256 id = _disputed();

        assertEq(escrow.deliveryHash(id), sha256(bytes(DELIVERY_NOTES)));
        assertEq(escrow.disputeHash(id), sha256(bytes(DISPUTE_NOTES)));
        assertEq(
            escrow.evidenceRoot(id),
            keccak256(abi.encode(sha256(bytes(DELIVERY_NOTES)), sha256(bytes(DISPUTE_NOTES)))),
            "evidence root is derived from stored text, never supplied"
        );
    }

    function test_PurchaseCount_TracksOffers() public {
        assertEq(escrow.purchaseCount(), 0);
        _offer();
        _offer();
        assertEq(escrow.purchaseCount(), 2);
    }

    // =====================================================================
    // Cross-language hash vectors
    // =====================================================================

    /// @dev The escrow and the GenLayer judgment contract are the only two
    ///      implementations of these hashes, and they run in different languages
    ///      on different chains. Nothing inside either can detect that the other
    ///      started trimming whitespace: this contract would stay internally
    ///      consistent while every dispute became unjudgeable.
    ///
    ///      So the vectors in docs/vectors/hash-vectors.json are the contract
    ///      between the two — and every case in them is one where a
    ///      well-meaning cleanup would change the bytes.
    function test_HashVectors_PromiseHashMatchesSharedVectors() public {
        HashVectors.StringVector[] memory vectors = HashVectors.stringVectors();
        assertGt(vectors.length, 0, "generator produced no vectors");

        for (uint256 i = 0; i < vectors.length; i++) {
            vm.prank(seller);
            uint256 id = escrow.createOffer(
                PRICE,
                uint64(block.timestamp) + DELIVERY_OFFSET,
                REVIEW_WINDOW,
                vectors[i].text,
                _rubric()
            );
            assertEq(escrow.promiseHash(id), vectors[i].digest, vectors[i].name);
        }
    }

    function test_HashVectors_NotesHashMatchesSharedVectors() public {
        HashVectors.StringVector[] memory vectors = HashVectors.stringVectors();

        for (uint256 i = 0; i < vectors.length; i++) {
            uint256 id = _funded();

            vm.prank(seller);
            escrow.submitDelivery(id, vectors[i].text);
            assertEq(escrow.deliveryHash(id), vectors[i].digest, vectors[i].name);

            vm.prank(buyer);
            escrow.openDispute(id, 0x1, vectors[i].text);
            assertEq(escrow.disputeHash(id), vectors[i].digest, vectors[i].name);
        }
    }

    function test_HashVectors_RubricHashMatchesSharedVectors() public {
        HashVectors.RubricVector[] memory vectors = HashVectors.rubricVectors();
        assertGt(vectors.length, 0, "generator produced no vectors");

        for (uint256 i = 0; i < vectors.length; i++) {
            vm.prank(seller);
            uint256 id = escrow.createOffer(
                PRICE,
                uint64(block.timestamp) + DELIVERY_OFFSET,
                REVIEW_WINDOW,
                PROMISE,
                vectors[i].rubric
            );
            assertEq(escrow.rubricHash(id), vectors[i].digest, vectors[i].name);
        }
    }

    /// @dev The counterexample, stated as a test: if this contract normalised
    ///      before hashing, these would be equal. They must not be.
    function test_HashVectors_WhitespaceIsSignificant() public {
        HashVectors.StringVector[] memory vectors = HashVectors.stringVectors();

        uint256 trailingNewline = type(uint256).max;
        uint256 padded = type(uint256).max;
        for (uint256 i = 0; i < vectors.length; i++) {
            bytes32 nameHash = keccak256(bytes(vectors[i].name));
            if (nameHash == keccak256("promise_trailing_newline")) trailingNewline = i;
            if (nameHash == keccak256("promise_leading_and_trailing_spaces")) padded = i;
        }
        assertTrue(trailingNewline != type(uint256).max, "vector missing");
        assertTrue(padded != type(uint256).max, "vector missing");

        assertTrue(
            vectors[trailingNewline].digest != sha256(bytes("Deliver three illustrations.")),
            "a trailing newline must change the hash"
        );
        assertTrue(
            vectors[padded].digest != sha256(bytes("Deliver three illustrations.")),
            "leading and trailing spaces must change the hash"
        );
    }

    // =====================================================================
    // Constructor validation
    // =====================================================================

    function test_Constructor_RejectsZeroAddresses() public {
        vm.expectRevert("usdc=0");
        new RecourseEscrow(
            IERC20(address(0)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, BOND_BPS, owner
        );

        vm.expectRevert("sourceChainId=0");
        new RecourseEscrow(IERC20(address(usdc)), 0, SOURCE_CONTRACT, relayer, BOND_BPS, owner);

        vm.expectRevert("sourceContract=0");
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, address(0), relayer, BOND_BPS, owner
        );

        vm.expectRevert("relayer=0");
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, address(0), BOND_BPS, owner
        );

        vm.expectRevert("owner=0");
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, BOND_BPS, address(0)
        );
    }

    function test_Constructor_EnforcesBondBpsRange() public {
        vm.expectRevert("bond bps range");
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, 99, owner
        );

        vm.expectRevert("bond bps range");
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, 2_001, owner
        );

        // The documented boundaries themselves are accepted.
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, 100, owner
        );
        new RecourseEscrow(
            IERC20(address(usdc)), SOURCE_CHAIN_ID, SOURCE_CONTRACT, relayer, 2_000, owner
        );
    }

    // ---------------------------------------------------------------------

    function _repeat(string memory ch, uint256 count) internal pure returns (string memory out) {
        bytes memory b = new bytes(count);
        for (uint256 i = 0; i < count; i++) {
            b[i] = bytes(ch)[0];
        }
        out = string(b);
    }
}
