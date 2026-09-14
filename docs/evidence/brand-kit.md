# Brand kit — Recourse

Delivered: 2026-09-13
Everything is in this one document. The PNG exports are listed in the manifest
at the end; the SVG source for both marks is inline below, so the marks can be
recovered from this file alone even if the archive is lost.

---

## 1. Primary mark

The primary mark is a rounded square holding a balance beam. The beam is level
when the two pans are equal weight, which is the whole product in one shape: the
payment sits in the middle until both sides agree.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img"
     aria-label="Recourse primary mark">
  <rect x="4" y="4" width="88" height="88" rx="20" fill="#0B1220"/>
  <rect x="46" y="22" width="4" height="40" rx="2" fill="#F5F7FA"/>
  <rect x="26" y="24" width="44" height="4" rx="2" fill="#F5F7FA"/>
  <path d="M26 28 L18 44 H34 Z" fill="#3B82F6"/>
  <path d="M70 28 L62 44 H78 Z" fill="#3B82F6"/>
  <circle cx="48" cy="70" r="7" fill="#3B82F6"/>
</svg>
```

Exports: `logo-primary.svg` (source above), `logo-primary.png` (512×512,
transparent), `logo-primary@2x.png` (1024×1024).

## 2. Wordmark

The wordmark is the product name set in the same geometry as the mark, with the
beam's balance point standing in for the counter of the `o`. It is never used
without the primary mark on first appearance of a page.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 64" role="img"
     aria-label="Recourse wordmark">
  <text x="0" y="44" font-family="Inter, sans-serif" font-size="44"
        font-weight="600" letter-spacing="-1.2" fill="#F5F7FA">Rec</text>
  <circle cx="132" cy="30" r="12" fill="none" stroke="#F5F7FA" stroke-width="5"/>
  <circle cx="132" cy="30" r="4" fill="#3B82F6"/>
  <text x="152" y="44" font-family="Inter, sans-serif" font-size="44"
        font-weight="600" letter-spacing="-1.2" fill="#F5F7FA">urse</text>
</svg>
```

Exports: `wordmark.svg` (source above), `wordmark.png` (960×192, transparent).

## 3. Colour palette

Every colour the kit uses, as hex. There are six, and nothing outside this table
appears in any file above.

| Name         | Hex       | Used for                                  |
| ------------ | --------- | ----------------------------------------- |
| Midnight     | `#0B1220` | Page ground, primary mark field           |
| Slate        | `#1C2637` | Raised surfaces, cards                    |
| Bezant Blue  | `#3B82F6` | The beam's pans, accent, links, focus ring |
| Ice          | `#F5F7FA` | Body text on Midnight and Slate           |
| Pewter       | `#8A8F98` | Secondary text — see the note below       |
| Signal Amber | `#F59E0B` | Disputed state, warnings                  |

**Contrast note.** Pewter on Midnight measures 5.1:1 and is fine for body text
at or above 16px. It measures 2.9:1 on Ice, which fails WCAG AA — it is a
dark-theme-only colour and the kit does not ship a light-theme equivalent.

## 4. Manifest

| File                  | Dimensions | Bytes  |
| --------------------- | ---------- | ------ |
| `logo-primary.svg`    | 96×96      | 604    |
| `logo-primary.png`    | 512×512    | 18,204 |
| `logo-primary@2x.png` | 1024×1024  | 61,880 |
| `wordmark.svg`        | 320×64     | 812    |
| `wordmark.png`        | 960×192    | 22,416 |
| `brand-kit.md`        | —          | this file |

Six files, delivered as this document plus the five exports it lists.
