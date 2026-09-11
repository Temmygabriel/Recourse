# Recourse — Design Direction Update: Security Paper

Supersedes `docs/specs/design_spec.md` §1 (concept) and §2 (design tokens) only.
Everything else in that file still holds: the hero moment (§3), the information
hierarchy (§4), the screen list and their functional jobs (§5), the copy voice
(§6), and what's out of scope (§7). This document only changes what things
*look like*, and adds one new screen. Read this alongside the original spec,
not instead of it.

Reference implementation for every color/spacing value below: three approved
mockups already reviewed and signed off — do not deviate from these values
without checking back first.

---

## 1. What changed, and why

The original theme (light neutral paper, hairline gray borders, one accent
color used sparingly) tested as flat — reviewers said it "still looks lame"
and "still looks grey" even after contrast fixes. The concept (inspection
record / promise checked against delivery) was never the problem. The
execution was too restrained to read as intentional rather than unstyled.

**New material reference: security paper** — the pale, faintly-patterned
stock used on checks, stock certificates, and legal documents, specifically
because it's hard to forge. This is a *tighter* metaphor for Recourse than
plain white paper: the anti-forgery pattern is a visual echo of the actual
hash-locked, tamper-evident evidence model already built into the contract
(`docs/DATA_MODEL.md` §3). Keep leaning into that connection in any future
copy or visual decisions — it's more specific to this product than "generic
inspection form" was.

Self-check against generic AI defaults, redone for this direction: still no
dark mode, still no rounded SaaS cards, still no neon, still no ALL-CAPS
eyebrow labels. This is not the cream/serif/terracotta editorial combo either
— sage-green security paper with a burgundy stamp accent is a different,
more specific reference than that.

---

## 2. Design tokens — replace `frontend/tailwind.config.ts` color block

```ts
colors: {
  paper: '#E9F0E2',        // was #FAFAF8 — pale sage security-paper stock
  surface: '#F3F7EE',      // was #FFFFFF — card surface, slightly warmer than paper
  ink: {
    DEFAULT: '#1B2620',    // was #16161A — deep green-black, not pure black
    muted: '#4B5A44',      // was #5B5B63 — muted sage-gray for secondary text
  },
  rule: '#C9D8BC',         // was #E4E4E0 — sage-toned hairline, used for borders
                            // AND the security-band pattern (see §3)
  pending: '#8A7A3C',      // unchanged — amber, for procedural "waiting" states
                            // (FUNDED, DELIVERED-awaiting-review)
  contested: '#7A2331',    // NEW — burgundy, real rubber-stamp ink color.
                            // Used for: the "In dispute" status badge, the
                            // highlighted unmet-criterion row, AND both
                            // PARTIAL_REFUND and FULL_REFUND verdict stamps.
                            // One hue now covers "being contested" and "a
                            // refund happened" — the stamp's own text and the
                            // money split already distinguish partial from
                            // full, so a second refund hue added noise
                            // without adding information.
  release: '#2F6B4F',      // unchanged — met / released to seller
  accent: '#1F3A5F',       // unchanged — reserve for plain text links only now.
                            // Primary buttons no longer use an outlined accent
                            // border; see §4.
}
```

Delete the old `partial` and `refund` keys — both verdict tones now resolve to
`contested`. Search the codebase for `partial-` and `refund-` Tailwind
classes (`status-partial`, `status-refund`, `stamp-partial`, `stamp-refund`)
and repoint them at `contested`.

---

## 3. The security band — new, applies once per page

A thin repeating-diagonal-line strip, echoing the guilloché engraving on real
security paper. Add to `globals.css`:

```css
.security-band {
  height: 8px;
  background-image: repeating-linear-gradient(
    135deg,
    theme('colors.rule') 0px,
    theme('colors.rule') 1.5px,
    transparent 1.5px,
    transparent 7px
  );
}
```

Place one at the very top of `AppHeader` and one at the very bottom of the
footer in `layout.tsx` — **once per page load, not per-card.** It's a page
frame, not a repeating card decoration. Do not add it inside `.doc-card` or
`.exhibit`.

---

## 4. Buttons — solid ink, not outlined accent

`.btn-primary` changes from an outlined accent button to a solid one:

```css
.btn-primary {
  @apply border-ink bg-ink text-paper hover:bg-[#0F1712] hover:border-[#0F1712];
}
```

This was flagged directly in review: the old accent-blue outline was barely
visible and the app wasn't spending its one accent color anywhere. A solid
ink-filled button reads as the obvious primary action on every screen. Keep
`.btn-secondary` and `.btn-danger` as outlined — the contrast between one
solid button and everything else outlined is what makes the primary action
findable.

---

## 5. Requirement circles — filled, not just left-border

Currently a requirement's status is shown with a colored left border on the
row (`.req-met` / `.req-unmet`). Reviewed mockups show something stronger:
**the numbered circle itself fills with color once there's a verdict.**

Update `RequirementList.tsx` / `globals.css`:

- No mark yet (still listing criteria, nothing judged): circle stays outlined,
  `border: 1px solid var(--ink)`, number in ink, transparent fill — this is
  the existing `.req-num` look, unchanged.
- `met`: circle fills solid `release` green, number renders in `paper` color.
- `unmet`: circle fills solid `contested` burgundy, number renders in `paper`
  color, **and** the whole row gets a faint burgundy wash behind it
  (`background: theme('colors.contested') / 7%` or the existing
  `rgba(122,35,49,0.07)`), pulled slightly wider than the row padding so it
  reads as a highlighted block, not just colored text. This is what makes the
  point of conflict visually unmissable on the case and verdict screens —
  keep the left-border treatment too, it's not being removed, just no longer
  doing all the work by itself.

---

## 6. Screen-by-screen changes

All eight routes get the token swap in §2 automatically once
`tailwind.config.ts` and `globals.css` are updated — most screens need no
other change. These need more than the token swap:

### 6.1 Home (`app/page.tsx`) — add the pitch header, keep the real list below

This screen was previously just the offer list. Add a hero block **above**
the existing list, in the same file, using real data where it's easy:

- Headline (32px, weight 700, max ~17ch): *"Buy from creators. Get refunded
  automatically if they don't deliver."*
- One-line subhead (13px, `ink-muted`, sans, max ~46ch) explaining escrow +
  GenLayer verification in plain language — see the approved mockup copy.
- A three-step row (pay → deliver → verify), each step a 44px circle icon
  in an outlined ink circle (green outline + green icon on the third step
  only), a 12px bold label, an 11px muted description. Use the three inline
  SVGs in §7 — do not add an icon library dependency for three icons.
- **A live proof card, using real data, not a static mockup.** If there's at
  least one `SETTLED` purchase, render a compact version of the actual
  verdict — reuse `Stamp` and the settlement amounts from `fetchSettlement`,
  same components the verdict page already uses. If nothing has settled yet,
  omit this card entirely rather than showing fabricated numbers — an empty
  state here is more honest than fake proof, and the rest of the hero still
  carries the pitch on its own.
- Keep the existing "Open offers" / "In progress and closed" sections exactly
  as they are, just below this new block, restyled by the token swap only.

### 6.2 `PurchaseRow.tsx` — add the stage-coded left bar

Extend the existing `.req-unmet`/`.req-met` left-border pattern to purchase
rows themselves: `OPEN` gets a thin `ink` left border, `DISPUTED` gets
`contested`, `SETTLED` gets `release` (or `contested` if the settlement was a
refund — check `outcome`), `FUNDED`/`DELIVERED` get `pending`. This is what
lets someone scan the whole list by color before reading any text.

### 6.3 Offer detail (`offers/[id]/page.tsx`)

Token swap only, plus: give the promise card more visual weight than the
price panel — larger padding, the promise text at 13-14px rather than
matching the muted meta text size. The price panel becomes its own bordered
block (not just a plain column) with the amount rendered large (22px) at the
top of it, like a payment stub.

### 6.4 Deliver (`offers/[id]/deliver/page.tsx`)

Token swap only. No structural change.

### 6.5 Dispute (`dispute/[id]/page.tsx`)

Token swap only. The requirement checklist here should already pick up the
filled-circle treatment from §5 for any criterion the buyer selects (use the
`contested` fill on selection, not a new color).

### 6.6 Case comparison (`case/[id]/page.tsx`) — the hero moment

Highest-priority screen for the new treatment:
- Apply the filled-circle + row-wash treatment from §5 to the requirement
  list on the "Promised" side.
- Give delivery/dispute evidence boxes (`.exhibit`) a **dashed** border
  instead of solid — `border: 1px dashed var(--rule)`, background one shade
  lighter than `surface`. This reads as "attached exhibit," distinct from the
  solid-bordered document cards around it.
- The dispute bond gets its own bordered strip at the bottom of the card, not
  inline prose — see the approved mockup for exact layout.

### 6.7 Verdict (`verdict/[id]/page.tsx`)

Token swap only — `Stamp` component already picks up the `contested` color
for both `PARTIAL_REFUND` and `FULL_REFUND` once §2's token change lands.

### 6.8 Receipt (`receipt/[id]/page.tsx`)

Token swap only.

---

## 7. Icons — three inline SVGs, no new dependency

Add as a new file `frontend/src/components/Icon.tsx`. Kept dependency-free on
purpose, matching the reasoning already in `MEMORY.md` D8 (no wagmi/RainbowKit
to keep the tree small) — three icons don't justify a library.

```tsx
export function CardIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6">
      <rect x="2.5" y="5" width="19" height="14" rx="1.5" />
      <line x1="2.5" y1="10" x2="21.5" y2="10" />
    </svg>
  );
}

export function PackageIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6">
      <path d="M3 8l9-5 9 5-9 5-9-5z" />
      <path d="M3 8v9l9 5 9-5V8" />
      <path d="M12 13v9" />
    </svg>
  );
}

export function ShieldCheckIcon({ color = 'currentColor' }: { color?: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
```

Use `ShieldCheckIcon` in the header wordmark too (24px, in a 30px outlined
ink circle) — it's the one recurring mark for the brand, not just the third
step icon.

---

## 8. What did not change

The information hierarchy (§4 of the original spec), the copy voice and
banned buzzwords (§6), the explicit out-of-scope list (§7), and the "verdict
comes from Base, never GenLayer" rule in `MEMORY.md` are all unaffected by
this document. This is a visual pass only — no data model, contract, or
relayer logic changes as a result of anything here.
