# Recourse — Build Spec

Hackathon: GenLayer Agent Tank, Track 4 — Onchain Justice
Build window: Sept 3–17, 2026 (today: Sept 10 — 7 days remaining)
Prize: share of 5% of all GenLayer Points

---

## 1. The pitch (30 seconds)

Onchain payments made commerce easy. Recourse makes mistakes refundable.

A buyer pays a creator or seller through Base escrow. The promise — exactly what
was being sold — is locked at the moment of purchase, in plain English plus
structured acceptance criteria. If the seller delivers, funds release normally.
If the buyer thinks the delivery doesn't match what was promised, they open a
dispute. GenLayer's validator network — not Recourse, not either party —
independently compares the frozen promise against the submitted evidence and
returns one verdict: RELEASE, PARTIAL_REFUND, FULL_REFUND, or UNDETERMINED. Base
settles automatically.

Base holds the money. The app holds the evidence. GenLayer decides whether the
promise was kept.

---

## 2. Scope

### MVP — build this

- Seller creates an offer: title, price (USDC), plain-English promise, 2–4
  structured acceptance criteria, delivery deadline.
- Buyer pays into a Base escrow contract.
- Seller submits delivery: a URL/hash plus short evidence notes, before the
  deadline.
- Buyer has a fixed review window to accept or open a dispute.
- Opening a dispute requires a small bond (see Section 4) and selecting which
  specific criterion failed, not a free-form complaint.
- On dispute, a GenLayer Intelligent Contract evaluates the frozen promise,
  frozen rubric, and both parties' evidence, and returns a structured verdict.
- Base settlement executes only once GenLayer's result reaches `Finalized` (see
  Section 4) and only once per purchase.
- Two supported deliverable classes only: (1) creator commission / paid
  content, (2) structured research/data deliverables.

### Explicitly out of scope for the hackathon build

- Physical-goods disputes, identity/KYC verification, fraud investigation,
  general legal arbitration, multi-party cases.
- Arbitrary file types or arbitrary live webpages as evidence.
- Any wallet-based "reputation" or "trust score" — do not build this; it
  implies wallet uniqueness maps to human uniqueness, which is false (see
  Section 4).
- Token/points gamification, activity feeds, AI chat assistant, generic
  marketplace browsing, complex appeal trees, a "validator explorer" home
  screen.
- Mainnet or real funds. Testnet only for the entire hackathon build.

---

## 3. Architecture

```
                  BASE
        ┌────────────────────────┐
        │  Escrow Contract       │
        │  purchase commitment   │
        │  USDC in/out           │
        │  dispute bond          │
        │  deadline state machine│
        └───────────┬────────────┘
                    │ dispute opened
                    ▼
        ┌────────────────────────┐
        │ Evidence package       │
        │ promise + rubric +     │
        │ delivery + dispute     │
        │ evidence (hash-pinned) │
        └───────────┬────────────┘
                    │
                    ▼
              GENLAYER
        ┌────────────────────────┐
        │ Intelligent Contract   │
        │ one narrow judgment:   │
        │ materially fulfilled?  │
        │ RELEASE/PARTIAL/FULL/  │
        │ UNDETERMINED           │
        └───────────┬────────────┘
                    │ consensus result
                    ▼
        wait for FINALIZED
        (do not act on Accepted)
                    │
                    ▼
                  BASE
        ┌────────────────────────┐
        │ verify decision context│
        │ verify nonce unused    │
        │ settle exactly once    │
        └────────────────────────┘
```

### Components

1. **Base escrow contract** (Solidity). Holds the purchase commitment
   (`promiseHash`, `rubricHash`, price, deadline, refund schedule), holds USDC,
   holds the dispute bond, enforces the state machine (Created → Delivered →
   ReviewWindow → Disputed → Settled), and performs the final one-time payout.
2. **GenLayer Intelligent Contract** (Python/GenVM). Receives the frozen
   promise, frozen rubric, and evidence commitment. Runs the judgment. Returns
   a structured decision, not free text.
3. **Relayer**. Off-chain service that watches GenLayer for a `Finalized`
   result and submits it to the Base escrow contract. Treat this as a **named
   trust boundary**, not a detail — see Section 4.1.
4. **Frontend** (Next.js, deployed to Vercel). See design spec for screens.

### GenLayer judgment interface

```python
# Input (all fields frozen/hashed before the LLM ever sees them)
promise_hash: str          # hash of the locked plain-English promise
rubric: list[str]           # 2-4 structured acceptance criteria, frozen at purchase
delivery_evidence: dict     # seller's submission: hash + short notes
dispute_evidence: dict      # buyer's submission: which criterion failed + notes
delivery_hash: str          # content hash of what was actually delivered

# Output — structured only, never free text as the decision itself
{
  "outcome": "RELEASE" | "PARTIAL_REFUND" | "FULL_REFUND" | "UNDETERMINED",
  "refund_bps": int,             # 0-10000, only used if PARTIAL_REFUND
  "criteria_met": [bool, ...],   # one entry per rubric item
  "reason": str                  # short, evidence-grounded, capped length
}
```

### Settlement verification (Base side)

Base must reject settlement unless **all** of the following hold:

```
bridge/oracle authorization signature is valid
AND source network is the expected GenLayer deployment
AND genlayerTxId matches this purchase's open dispute
AND decisionId/nonce has not been consumed before
AND promiseHash + rubricHash + evidenceRoot match Base's stored state
AND GenLayer result status == FINALIZED (never settle on Accepted alone)
AND outcome ∈ {RELEASE, PARTIAL_REFUND, FULL_REFUND, UNDETERMINED}
```

GenLayer's own consensus is provisional until an appeal window closes. Current
verified appeal escalation is **5 → 11 → 23** validators (2N+1 per round,
confirmed directly on genlayer.com) — do not build against a smaller/different
sequence. Applications must not assume a fixed appeal duration; read it from
protocol state.

---

## 4. Security and anti-gaming rules — build these as actual code, not later hardening

### 4.1 Relayer / bridge authorization (P0 — highest risk)

The relayer is currently the single biggest way this system could be silently
broken: if Base trusts *any* signed message claiming to be a GenLayer result,
the relayer becomes the real judge, not GenLayer.

**Build rule:** Base's settlement function must verify the relayer's message
against the exact `SettlementDecision` structure in Section 3, check the nonce
has not been used, and reject anything that isn't `FINALIZED`. If true
cryptographic proof of GenLayer finality can't be built in the hackathon
window, the README and the demo must say explicitly: *"the relayer is a
trusted prototype component; this is testnet-only."* Do not claim
"trustless" if it isn't.

### 4.2 Prompt injection into the judgment layer (P0)

Evidence text, notes, and linked content are adversarial input by default —
both parties are self-interested.

**Build rules**, following the pattern independently verified in a comparable
live GenLayer Onchain Justice project (PhiBao/gotham-court):
- Wrap all user-submitted text in explicit `BEGIN_EVIDENCE` / `END_EVIDENCE`
  markers with an explicit instruction in the contract-authored prompt to
  ignore any instructions found inside those markers.
- Truncate every input field with a hard limit (e.g. promise: 500 chars,
  rubric item: 200 chars, dispute notes: 2,000 chars, delivery notes: 2,000
  chars). Reject whitespace-only submissions.
- Never let the LLM's free-text output *be* the decision. The output must
  match the structured schema in Section 3; a deterministic guard in contract
  code clamps or rejects anything outside it.
- Restrict accepted evidence to hash-pinned content, not live/arbitrary URLs
  (see 4.3) — this also closes off the "different content to bot vs. human"
  attack class.

### 4.3 Evidence timing and pinning (P0)

**Build rule:** at submission time, hash the actual evidence content (not just
store a mutable URL) and lock that hash into the purchase/dispute record. All
validators must evaluate the same frozen artifact. For the MVP, restrict
evidence to a small set of supported formats (text, a single image, a
structured data file) that can be hashed and stored via a content-addressed
store, not an arbitrary live webpage that could change or serve different
content to different requesters.

### 4.4 Sybil / self-dealing (P1)

Wallet uniqueness is not human uniqueness. Do not build a reputation score
from wallet history — it's directly gameable and was flagged as a product
decision to avoid, not solve, for this hackathon.

**Build rule:** present factual transaction history only ("3 completed
purchases with this seller"), never a trust/reputation score. State plainly in
the UI and README that wallet activity is not identity verification.

### 4.5 Griefing / dispute spam economics (P1)

**Build rule:** opening a dispute costs a bond (e.g. a small percentage of the
purchase price), returned to the buyer if the dispute resolves in their favor
(fully or partially), forfeited toward the seller/protocol if the dispute
resolves as RELEASE. This makes frivolous disputes costly without blocking
genuine ones.

### 4.6 Replay / double-execution (P0)

**Build rule:** every `SettlementDecision` carries a unique nonce tied to the
purchase ID. The Base contract must mark it consumed atomically with payout,
and reject any repeat submission of the same nonce/decision.

### 4.7 Access control (P0)

**Build rule:** only the verified relayer signature (per 4.1) can call the
settlement function. No admin key should be able to directly force a payout
outcome outside the GenLayer-verified path, other than a clearly-labeled
emergency-pause (not a redirect-funds) function, for testnet safety only.

### 4.8 Key/credential blast radius (P1)

List every key before building: escrow contract admin key (pause only, no
fund redirection), relayer signing key (can only relay verified decisions, not
withdraw), any GenLayer deployer key. Document the worst case for each in the
README.

---

## 5. Day-by-day plan (Sept 10 → Sept 17)

**Day 1 (Sept 10, remainder of today)**
Scaffold repo structure (contracts/, relayer/, frontend/, test/, docs/). Write
the purchase/dispute data model. Deploy skeleton Base escrow to testnet.

**Day 2 (Sept 11)**
Base escrow contract: full state machine (Created → Delivered → ReviewWindow →
Disputed → Settled), USDC in/out, dispute bond logic. Tests for the state
machine, including replay/double-settlement attempts.

**Day 3 (Sept 12)**
GenLayer Intelligent Contract: judgment logic, structured output schema,
prompt-injection hardening (4.2). Deploy to GenLayer testnet, test with hand-
built evidence pairs (clear pass, clear fail, ambiguous case, injection
attempt).

**Day 4 (Sept 13)**
Relayer service: watch GenLayer for `Finalized` results, submit to Base with
the full `SettlementDecision` verification in Section 3. This is the P0
component — do not shortcut it. Test the rejection paths (wrong nonce, not
finalized, mismatched hash) explicitly, not just the happy path.

**Day 5 (Sept 14)**
Frontend core flow: offer creation, payment, delivery submission, dispute
trigger with criterion selection. Wire to contracts on testnet.

**Day 6 (Sept 15)**
Frontend verdict flow: promise-vs-evidence comparison screen (hero moment),
verdict reveal, settlement receipt. Full end-to-end test on testnet with real
transactions.

**Day 7 (Sept 16)**
Security/chaos pass against Section 4 explicitly — try to break your own
replay protection, try a prompt-injection payload, try opening a dispute with
no bond. Fix what breaks. Record the demo video.

**Day 8 (Sept 17, submission day)**
Buffer for fixes. Finalize README with the honest security narrative (Section
6). Submit: public GitHub repo, demo video, project application.

---

## 6. The security narrative for the submission

> Recourse does not try to make AI infallible. It makes the attack surface
> small. The purchase promise is frozen. The evidence is frozen. The rubric is
> frozen. GenLayer answers one narrow question. Base waits for finality before
> it pays. The settlement contract verifies the full decision context and can
> execute it exactly once. Wallet activity is shown as fact, never sold as
> trust.

Use this framing in the README and the demo — it's a stronger, more credible
story than presenting Recourse as a general AI court.

---

## 7. Submission checklist (Agent Tank requirements)

- [ ] Public GitHub repository (confirmed requirement from the hackathon page)
- [ ] Full project application submitted through the portal
- [ ] One project per portal account
- [ ] Track selected: Onchain Justice
- [ ] Original idea — not a clone of an existing listed live project
      (differentiate explicitly from Internet Court in the README)
- [ ] Demo video
- [ ] README documents the security model honestly, including what's a
      trusted-prototype component (the relayer) vs. what's actually verified
      on-chain
- [ ] Submitted before the Sept 17, 2026 build-window close
