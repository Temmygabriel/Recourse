# Recourse — Data Model

The single source of truth for field names and bounds across all three layers
(Solidity escrow, GenLayer judgment contract, frontend/relayer TypeScript).

Every field is listed once, here, with its owning layer. If a name differs
between layers, that is a bug.

---

## 1. Layers and who owns what

| Layer | Owns | Never owns |
|:--|:--|:--|
| **Base escrow** (`RecourseEscrow.sol`) | the money, the commitment hashes, the state machine, the nonce ledger | promise text, evidence text, the verdict |
| **GenLayer** (`recourse_judgment.py`) | the judgment, the frozen promise/rubric/evidence *content* for the duration of a dispute | the money, the ability to move funds |
| **Relayer** (Node) | transport between the two, and its own signature | the verdict itself (it relays; it must not author) |
| **Frontend** (Next.js) | display, form validation, hash computation | any authority — it is a view over the above |

**Text lives off-chain; hashes live on-chain.** Both the promise and the
evidence are stored as UTF-8 strings in the app's records and as `bytes32`
commitments on Base and GenLayer. Every layer that receives text re-derives the
hash and rejects a mismatch. Nothing trusts a string it did not hash itself.

---

## 2. Field bounds (enforced at every layer)

| Field | Max length | Layer enforcement |
|:--|--:|:--|
| `title` | 120 chars | UI + escrow (`require`) |
| `promise_text` | 500 chars | UI + GenLayer (`_clamp`) |
| `rubric_item` | 200 chars | UI + GenLayer |
| `rubric` (list) | 2–4 items | UI + escrow + GenLayer |
| `delivery_notes` | 2,000 chars | UI + GenLayer |
| `dispute_notes` | 2,000 chars | UI + GenLayer |
| `reason` (LLM output) | 400 chars | GenLayer (clamped in contract code, not by the LLM) |

A whitespace-only submission is rejected at every layer. Truncation never
happens silently in the escrow — it reverts. The UI truncates visibly; GenLayer
clamps defensively because it cannot revert cheaply.

---

## 3. Commitments (the frozen artifacts)

```
promise_hash      = sha256(utf8(promise_text))                   # 32 bytes
rubric_hash       = sha256(utf8("\n".join(rubric_items)))        # 32 bytes
delivery_hash     = sha256(utf8(delivery_notes) || delivery_bytes)
dispute_hash      = sha256(utf8(dispute_notes))
evidence_root     = keccak256(abi.encode(delivery_hash, dispute_hash))
```

`rubric_hash` joins with a single `\n` in list order. The order is load-bearing:
criterion index `i` in the rubric is criterion `i` in `criteria_met`. Neither
party can reorder the rubric after purchase.

`evidence_root` is computed **by the escrow**, not supplied by the relayer. The
escrow recomputes it from its own stored `delivery_hash` and `dispute_hash` and
requires the signed decision to carry the same value. This is what stops a
relayer from settling against evidence the chain never saw.

---

## 4. Purchase — state machine

```
                 createOffer()
                      │
                      ▼
                 ┌─────────┐
                 │ CREATED │◄──── purchase() by buyer, USDC escrowed
                 └────┬────┘
                      │ submitDelivery() by seller, before deliveryDeadline
                      ▼
                 ┌───────────┐
                 │ DELIVERED │◄──── review window opens (deliveredAt + reviewWindow)
                 └─────┬─────┘
          ┌────────────┼──────────────┬─────────────────────┐
          │            │              │                     │
   accept()│    openDispute()  claimReviewTimeout()  claimDeadlineRefund()
   (buyer)  │     (buyer+bond)      (seller, after        (buyer, seller never
          │            │            window expires)        delivered, deadline passed)
          ▼            ▼                    ▼                     ▼
      ┌─────────┐  ┌──────────┐        ┌─────────┐          ┌─────────┐
      │ SETTLED │  │ DISPUTED │        │ SETTLED │          │ SETTLED │
      └─────────┘  └────┬─────┘        └─────────┘          └─────────┘
                        │ settle(decision) — relayer only,
                        │ requires FINALIZED + unused nonce
                        ▼
                   ┌─────────┐
                   │ SETTLED │
                   └─────────┘
```

`SETTLED` is terminal. There is no path out of it, and no admin function that
can produce a payout outside the `settle()` path. The only admin power is
`pause()`, which stops new purchases and new settlements but **cannot move,
redirect, or release funds**.

### Review window arithmetic

- `deliveryDeadline` — absolute unix seconds, set at offer creation, ≥ now + 1h.
- `reviewWindow` — duration in seconds, set at offer creation, 1h–30 days.
- Window closes at `deliveredAt + reviewWindow`. `accept()` and
  `openDispute()` are both valid until then.
- After the window closes, **only** `claimReviewTimeout()` (releases to seller)
  is valid. The buyer can no longer dispute — the deadline is procedural, and
  the UI shows it counting down so it is never a surprise.

### Late delivery

`submitDelivery()` after `deliveryDeadline` reverts. The buyer's recourse is
`claimDeadlineRefund()` — a full refund with no dispute and no bond. A seller
who cannot deliver in time loses the sale; nobody has to argue about quality.

---

## 5. Purchase record (on-chain)

```solidity
struct Purchase {
    uint256 id;
    address seller;
    address buyer;              // address(0) until purchased
    uint96  price;              // USDC, 6 decimals
    uint64  deliveryDeadline;   // unix seconds
    uint64  reviewWindow;       // seconds
    uint64  deliveredAt;        // 0 until delivered
    uint8   criteriaCount;      // 2..4
    Stage   stage;
    bytes32 promiseHash;
    bytes32 rubricHash;
    bytes32 deliveryHash;       // set at submitDelivery
    bytes32 disputeHash;        // set at openDispute
    uint8   disputedBitmap;     // bit i set => criterion i disputed
    uint96  disputeBond;        // USDC, 6 decimals
    bool    nonceConsumed;      // one settlement, ever
}
```

`disputedBitmap` is a bitfield, not a list: it cannot be mutated after the
dispute is opened, and it carries no free text. The buyer selects criteria by
index; the index maps back to the seller's own rubric, which the seller cannot
edit after purchase.

---

## 6. Verdict

```solidity
enum Outcome { RELEASE, PARTIAL_REFUND, FULL_REFUND, UNDETERMINED }
```

| Outcome | `refund_bps` | Buyer receives | Seller receives | Dispute bond |
|:--|--:|:--|:--|:--|
| `RELEASE` | must be 0 | — | 100% of price | **forfeited to seller** |
| `PARTIAL_REFUND` | 1–9999 | `price * bps / 10000` | remainder | returned to buyer |
| `FULL_REFUND` | must be 10000 | 100% of price | — | returned to buyer |
| `UNDETERMINED` | must be 0 | — | 100% of price | returned to buyer |

**Why `UNDETERMINED` releases to the seller.** The money was always going to
the seller on delivery; a dispute is a claim that it should not. An inconclusive
judgment does not establish that claim. The bond is still returned, so an
honest-but-ambiguous dispute costs the buyer nothing but time — only a dispute
that is affirmatively rejected as `RELEASE` forfeits the bond.

This also sets the incentive correctly: ambiguity is worse for whichever party
has the weaker case. The buyer is pushed to submit enough evidence to *prove* a
breach rather than to merely muddy the record, and the seller is pushed to
deliver clearly. There is no outcome in which a party profits from making the
evidence harder to read.

The alternative — treating `UNDETERMINED` as a buyer win — was rejected because
it pays the same as `FULL_REFUND` while requiring the buyer to prove nothing,
which is exactly the griefing path Section 4.5 of the build spec exists to
close.

---

## 7. SettlementDecision (what the relayer signs)

```solidity
struct SettlementDecision {
    uint256 purchaseId;
    uint256 nonce;              // unique per settlement, is the replay guard
    uint256 sourceChainId;      // GenLayer chain id the result came from
    address sourceContract;     // GenLayer contract that produced the verdict
    bytes32 genlayerTxHash;     // the GenLayer transaction
    bytes32 promiseHash;        // must equal the purchase's
    bytes32 rubricHash;         // must equal the purchase's
    bytes32 evidenceRoot;       // must equal keccak256(abi.encode(deliveryHash, disputeHash))
    bytes32 decisionDigest;     // hash of the full verdict payload (outcome, bps, criteria_met, reason)
    Outcome outcome;
    uint16  refundBps;
    bool    finalized;          // relayer asserts GenLayer status == FINALIZED
}
```

Signed per EIP-712 over the domain `("Recourse", "1", chainId, verifyingContract)`.

**Every one of these is checked by `settle()`.** The full rejection list is in
`docs/SECURITY.md`. `finalized` is the one field the chain *cannot* verify — it
is the documented trust boundary, and it is why the README does not call this
trustless.

---

## 8. Identity of a purchase in GenLayer

The GenLayer contract keys its decision store by `purchase_id`, derived
identically on both sides:

```
purchase_id = "recourse:" || chainId || ":" || escrowAddress || ":" || purchaseId
```

This binds a GenLayer decision to exactly one escrow on exactly one chain. A
decision produced for a testnet escrow cannot be replayed against a mainnet one
that happens to share a numeric purchase id.
