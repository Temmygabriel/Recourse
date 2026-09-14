# Accessibility audit — landing page

Target: `https://recourse.example/` (staging build `8f3c1d9`)
Standard: WCAG 2.2 Level AA
Audited: 2026-09-13
Method: manual keyboard and screen-reader pass, plus axe-core 4.10 as a cross-check.
Every finding below was reproduced by hand; axe-only findings were discarded.

Twelve failures found. Two of them (F7 and F11) describe a shared component
rather than the specific element inside it — where that is the case the entry
says so explicitly rather than naming an element it did not verify.

---

## F1 — Hero image has no text alternative

- **Element:** `<img class="hero__art" src="/hero.svg">` in `Hero.tsx`
- **WCAG:** 1.1.1 Non-text Content (A)
- **Observed:** the image is decorative in intent but carries the product's only
  statement of what it does. `alt` is absent entirely, so the accessible name is
  the filename `hero.svg`.
- **Fix:** `alt="Recourse holds a buyer's payment until the work is delivered."`

## F2 — Primary navigation is not reachable by keyboard

- **Element:** `<nav class="site-nav">`
- **WCAG:** 2.1.1 Keyboard (A)
- **Observed:** the nav is rendered only on `:hover` of its parent. With no
  pointer, it never enters the tab order.
- **Fix:** drive visibility from `:focus-within` as well as `:hover`.

## F3 — Focus indicator removed on all form controls

- **Element:** `input`, `textarea`, `select` under `.offer-form`
- **WCAG:** 2.4.7 Focus Visible (AA)
- **Observed:** a global `outline: none` in `base.css` with no replacement.
- **Fix:** restore a 2px focus ring with at least 3:1 contrast against the field.

## F4 — Price field rejects the value it displays

- **Element:** `<input id="price">` in `OfferForm.tsx`
- **WCAG:** 3.3.1 Error Identification (A)
- **Observed:** the field renders `1,500.00` but only accepts `1500`. Submitting
  the value as displayed produces a validation error naming no cause.
- **Fix:** strip group separators before validating, and name the expected
  format in the message.

## F5 — Error text is not associated with its field

- **Element:** `<span class="field-error">` in `OfferForm.tsx`
- **WCAG:** 3.3.1 Error Identification (A)
- **Observed:** the message is visually adjacent but has no `aria-describedby`
  and no `role="alert"`, so it is never announced.
- **Fix:** give the span an id and reference it from the input.

## F6 — Live region announces on every keystroke

- **Element:** `<div aria-live="polite" id="word-count">`
- **WCAG:** 4.1.3 Status Messages (AA)
- **Observed:** the count updates per character, so a screen reader narrates
  continuously while the user types.
- **Fix:** debounce to idle, or mark the region `aria-live="off"` and announce
  only on blur.

## F7 — Shared button component has insufficient contrast

- **Component:** `Button` (`components/ui/Button.tsx`), variants `ghost` and
  `outline`.
- **WCAG:** 1.4.3 Contrast (Minimum) (AA)
- **Observed:** `#8A8F98` on `#FFFFFF` measures 2.9:1 against a 4.5:1 minimum.
  **This entry names a component, not an element.** The component is used in
  eleven places; I verified the ratio from the token, not from each rendered
  usage, and I did not enumerate which pages are affected.
- **Fix:** darken the token to at least `#6B7280` (4.8:1) and re-check each
  usage, since two of them sit on a tinted background.

## F8 — Skip link targets a non-existent id

- **Element:** `<a class="skip-link" href="#main">`
- **WCAG:** 2.4.1 Bypass Blocks (A)
- **Observed:** the landmark is `<main id="content">`, so the skip link jumps
  nowhere and focus stays on the link.
- **Fix:** correct the fragment to `#content`.

## F9 — Form fields use placeholder as the only label

- **Element:** `#promise`, `#rubric-0`, `#rubric-1` in `OfferForm.tsx`
- **WCAG:** 3.3.2 Labels or Instructions (A)
- **Observed:** no `<label>`; the visible text is a placeholder, which vanishes
  on input and is not reliably exposed as an accessible name.
- **Fix:** add real labels; keep the placeholder as an example, not a name.

## F10 — Page has no level-one heading

- **Element:** the document `<h1>`
- **WCAG:** 1.3.1 Info and Relationships (A)
- **Observed:** the logo is an `<h2>`, and the offer heading is an `<h3>`, so
  the outline begins at level two and skips a level.
- **Fix:** make the page title the `<h1>` and demote the logo.

## F11 — Modal dialog does not trap focus

- **Component:** `ConfirmDialog` (`components/ui/ConfirmDialog.tsx`)
- **WCAG:** 2.4.3 Focus Order (A)
- **Observed:** focus escapes to the page behind the overlay on `Tab`, and
  `Escape` does not close. **This entry names a component, not an element.**
  I reproduced it in the accept-payment flow only; I did not test the other
  three call sites.
- **Fix:** trap focus within the dialog, restore it to the trigger on close,
  and wire `Escape`.

## F12 — Scrollable region is not keyboard-scrollable

- **Element:** `<div class="findings-table__scroll">`
- **WCAG:** 2.1.1 Keyboard (A)
- **Observed:** the wrapper has `overflow-x: auto` but no `tabindex`, so a
  keyboard user cannot reach the columns past the fold.
- **Fix:** add `tabindex="0"` and an accessible name.

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 2     |
| Serious  | 5     |
| Moderate | 4     |
| Minor    | 1     |

Re-audit recommended after F1–F4 and F7 are fixed, since F7's correction will
change the contrast of every button on the site.
