# Recourse — Design Spec

Companion to the build spec. This covers concept, visual system, screens, and
copy — everything DeepSeek needs to build the UI without further back-and-forth.

---

## 1. Concept and self-check

**Visual metaphor: a modern inspection record / proof-of-delivery file.**

Not a crypto dashboard. Not a generic SaaS product. The real subject matter of
this product is a promise, locked in writing, checked against what actually
arrived — closer to a customs inspection form or a claims file than a trading
app. The metaphor should shape layout and hierarchy, not become decoration.

**Self-check against generic AI-generated design defaults — confirmed avoided:**
- ❌ Dark mode + neon accent as the default palette
- ❌ Rounded SaaS dashboard card grids
- ❌ Cream/serif/terracotta editorial styling
- ❌ Decorative monospace text
- ❌ ALL-CAPS eyebrow labels
- ❌ AI-brain or blockchain-chain decorative icons

Instead: light neutral surfaces, strong black type, thin document-style rule
lines, restrained status colors (not a full neon palette), numbered
requirements, evidence attachments styled like exhibit items, and a
definitive stamped-style disposition mark for the verdict. Sentence-case
labels throughout. Monospace reserved only for genuine technical identifiers
(transaction hashes, purchase IDs) — never for decoration.

---

## 2. Design tokens

```
COLOR
  background:        #FAFAF8   (warm-neutral off-white, not pure white)
  surface:            #FFFFFF
  ink (primary text): #16161A   (near-black, not pure #000)
  ink-muted:           #5B5B63
  rule/divider:        #E4E4E0
  status-pending:       #8A7A3C  (muted amber, not neon)
  status-release:       #2F6B4F  (restrained green)
  status-partial:       #8A5A2B  (restrained ochre/brown)
  status-refund:        #7A3B3B  (restrained brick red)
  accent (interactive):  #1F3A5F  (deep slate blue — links, primary buttons)

TYPOGRAPHY
  display / headings:   a serious serif or high-contrast sans with a slight
                          institutional feel (e.g. a document/legal register,
                          not a rounded consumer-app font)
  body:                  a clean, highly legible sans (system UI stack is fine)
  technical identifiers:  monospace, small size, muted color — never decorative

LAYOUT
  base spacing unit:    8px
  document-card border: 1px solid rule color, sharp or minimally rounded
                          corners (2-4px, not the rounded-SaaS-card look)
  divider style:         thin hairline rules between sections, like a printed
                          form, not shadowed cards
```

---

## 3. The hero moment

**Promise vs. delivery evidence comparison, resolving directly into a verdict
and settlement.**

Sequence: show the locked promise and its numbered criteria first → map each
criterion to submitted evidence → visually highlight the criterion that failed
→ reveal the verdict (`PARTIAL_REFUND`, etc.) as a stamped disposition mark →
immediately show the resulting USDC settlement split.

This is the one screen a judge should remember without narration. Build it
first if time is short.

---

## 4. Information hierarchy (every buyer-facing screen)

Maintain this order everywhere:

1. **What did I buy?** — purchase name + amount
2. **What was promised?** — locked requirements, numbered
3. **What happened?** — delivery and dispute evidence
4. **What's happening now?** — current stage + deadline
5. **What happens to my money?** — protected amount + consequence

---

## 5. Screen-by-screen

### 5.1 Offer creation (seller)
**Job:** capture a promise specific enough that a dispute later has something
concrete to check against.
- Title, price (USDC), delivery deadline.
- Plain-English promise (one paragraph).
- 2–4 structured acceptance criteria, entered as a numbered list — these
  become the rubric GenLayer checks later. Don't let this be a free-text
  afterthought; the UI should make criteria feel load-bearing.

### 5.2 Purchase / pay (buyer)
**Job:** make the promise the primary object, not the transaction.
- Show the full locked promise and criteria before payment, exactly as the
  seller wrote them — this is the "receipt" the buyer is agreeing to.
- Pay into escrow (USDC). Confirm: "Your payment is protected until [date]."
- Explain escrow in one sentence, at this moment only — not in an upfront
  tutorial.

### 5.3 Delivery submission (seller)
**Job:** attach evidence to specific criteria, not a generic upload.
- One evidence slot per rubric criterion where possible, plus overall notes.
- Show the deadline clearly; submitting late should be visibly flagged.

### 5.4 Review window (buyer)
**Job:** low-friction acceptance, clear path to dispute.
- "Accept" is one tap.
- "Something's wrong" leads to 5.5, not a blank complaint box.
- Show the review window countdown plainly (Amazon/Etsy pattern: explicit
  procedural deadlines, not a vague "under review" state).

### 5.5 Open a dispute (buyer)
**Job:** classify before explaining — per PayPal/Etsy pattern, category before
essay.
- Buyer selects which specific locked criterion wasn't met (checkbox list
  generated from the seller's own rubric, not invented after the fact).
- Buyer adds concise supporting evidence for that criterion only.
- Show the dispute bond amount and what happens to it before the buyer
  confirms ("If GenLayer agrees with you, this bond is returned.").

### 5.6 Promise vs. evidence comparison (both parties, post-dispute)
**Job:** the hero moment. See Section 3.
- Two-column or stacked comparison: locked criterion → seller's evidence for
  it → buyer's dispute evidence for it, criterion by criterion.
- No confidence-score percentage anywhere. Show the mapped criteria outcome
  in plain language instead (e.g. "Requirement 2 — includes mobile version:
  not met").

### 5.7 Verdict reveal
**Job:** legitimate-feeling automated decision, not an arbitrary black box.
- Three-layer disclosure, all visible at once, not hidden behind clicks:
  1. **Decision** — "Partial refund — 30% returned to the buyer."
  2. **Evidence basis** — which criteria were met/not met, one line each.
  3. **Reviewability** — a link/expand to see the full promise, evidence, and
     decision record (for the technically curious and for judges).
- State plainly that GenLayer's validator network evaluated the evidence — do
  not imply a human reviewed it, and do not name a fictional "reviewer."

### 5.8 Settlement receipt
**Job:** close the loop, make the money movement visible and final.
- Show the exact split (e.g. "Seller: 175 USDC · Buyer: 75 USDC refunded").
- Link to the on-chain transaction.

---

## 6. Copy guidelines

Register: plain consumer-protection language, closer to how Etsy or Amazon
word a resolution than legal/arbitration language. Specific and concrete over
formal.

**Examples:**
- Verdict line: *"Partial refund — the delivery met 2 of 3 requirements you
  agreed to at purchase."* Not: *"Model confidence: 0.82."*
- Dispute prompt: *"Which part of the promise wasn't kept?"* Not: *"Describe
  your issue."*
- Escrow explainer (shown at payment only): *"Your payment is held until you
  confirm delivery or a dispute is resolved — the seller can't access it
  before then."*
- Evidence ask: *"Show us what was promised and what you received."* Not:
  *"Upload all available evidence."*

Avoid at all screens: "AI-powered," "decentralized," "validator-secured," or
similar buzzwords as the primary trust pitch. The trust pitch is the visible
chain — promise → evidence → finding → money — not the technology label.

---

## 7. What not to build in the first UX pass

Confirmed out of scope for the demo (dilutes the core story):
generic analytics dashboards, creator reputation/trust scores, an AI chat
assistant, a large activity feed, token/points gamification, a "validator
explorer" as a home screen, generalized marketplace browsing, complex appeal
trees, dozens of dispute categories, heavy blockchain jargon on every screen.

---

## 8. Build notes for DeepSeek

- Stack: Next.js (App Router), Tailwind CSS using the tokens in Section 2,
  deployed to Vercel — do not run heavy local dev servers by default, let
  Vercel build.
- Wallet: standard EVM wallet connect for Base testnet.
- Keep the seven screens in Section 5 as the entire MVP scope. Build 5.1
  through 5.3 first (the transactional flow), then 5.6/5.7 (the hero moment)
  before polishing 5.4/5.5/5.8 — the hero moment is what a judge remembers,
  prioritize it once the transactional plumbing works end-to-end.
- Evidence uploads: enforce the hash-pinning and format restrictions from the
  build spec (Section 4.3) at the UI layer too — don't accept arbitrary URLs
  in the delivery/dispute forms.
- No dark mode toggle needed for the hackathon build; ship the light
  inspection-record theme only.
