# Technical review — RecourseEscrow.sol

Reviewed: `contracts/src/RecourseEscrow.sol` at commit `8f3c1d9`
Reviewed: 2026-09-14
Scope: the escrow contract on Base Sepolia. The GenLayer judgment contract and
the relayer are out of scope except where the escrow's design constrains them.

Four findings. Each carries a severity and a code reference. Findings 1–3 also
carry a reproduction step; finding 4 does not have one, for the reason given in
its entry.

---

## 1. A dispute has no timeout, so a stalled relayer strands the money — High

`settle()` is the only transition out of `Stage.DISPUTED`:

```solidity
function settle(SettlementDecision calldata d, bytes calldata signature) external {
    ...
    require(p.stage == Stage.DISPUTED, "not disputed");
```

There is no `cancelDispute()`, no deadline on the disputed state, and no owner
escape hatch. If the relayer never submits a decision — it is down, the GenLayer
network is unavailable, a validator set fails to reach consensus on a persistent
5xx from the evidence host — the price and the bond stay in the contract
indefinitely and neither party can recover them.

This is the correct trade for the alternative (an owner who can settle
unilaterally is a much worse failure), but it is a liveness assumption that
should be stated rather than left implicit, and it is currently not in any
document.

**Reproduction:** `forge test --match-test test_DisputedHasNoExit` does not
exist, because there is no such exit to test. Read the state machine instead:
`settle` is the only function whose body can assign `Stage.SETTLED`, and its
second `require` gates on `DISPUTED`.

**Recommendation:** add a `disputeExpiresAt` set at `openDispute()` and a
`refundAfterTimeout()` callable by either party once it passes, returning price
and bond to the buyer. Alternatively, document the assumption and accept it for
a prototype — but do it explicitly.

## 2. `finalized` is a trust boundary, not a verified field — Informational

`SettlementDecision.finalized` is signed by the relayer but cannot be checked
on-chain: an EVM contract cannot read GenLayer consensus state, so there is no
value the escrow could compare it against. The contract's own comment says so,
and the field is carried into the `Settled` event rather than enforced.

This is honest and correctly documented, but it means the escrow's security
reduces entirely to "the relayer is honest" — which is true, and should be said
in the README in those words rather than left to a source comment. A reader who
sees fourteen `require`s in `settle()` could reasonably conclude the contract is
verifying more than it is.

**Code reference:** `RecourseEscrow.sol`, the block comment above
`struct SettlementDecision`, which lists exactly which fields are VERIFIED and
which are NOT VERIFIABLE.

**Recommendation:** repeat that split in `docs/SECURITY.md` and in the README's
limitations section. Do not describe the system as trustless.

## 3. `disputeBond` has a proportional floor but no absolute one — Low

```solidity
function disputeBond(uint96 price) public pure returns (uint96) {
    return uint96((uint256(price) * DISPUTE_BOND_BPS) / 10_000);
}
```

At 500 bps the bond is 5% of price, with no minimum. An offer priced at 1 USDC
(a legitimate number for a small deliverable) carries a 0.05 USDC bond, which
makes opening a frivolous dispute nearly free and makes the bond a poor
deterrent at the low end. The bond does its job at the prices the demo uses;
it is the tail that is unguarded.

**Reproduction:** create an offer at `price = 1` and read `disputeBond(1)`,
which returns `0`. At a price of 19 the bond is still `0`, because the integer
division truncates — so a purchase can be disputed for free.

**Recommendation:** `return uint96(Math.max(1e6, ...))` — a 1 USDC floor — or
require a minimum price at `createOffer()`.

## 4. The review window is frozen at creation

`reviewWindow` is set in `createOffer()` and copied into the purchase at
`purchase()`. There is no way to extend it afterwards, and `acceptDelivery()`
reverts once `deliveredAt + reviewWindow` has passed.

This is finding 4 and it carries no severity rating. I am leaving it that way
deliberately rather than guessing: I think it is defensible as designed — the
window is part of the offer the buyer accepted, and changing it later would let
the seller buy more time after seeing the work — but I have not convinced myself
it is not a problem for a buyer who is simply away when the delivery lands, and
I would rather flag it as unresolved than label it. Every other finding above
has a rating because I reached a conclusion on it; this one I did not.
