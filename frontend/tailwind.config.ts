/**
 * Tailwind v3 (3.4.19, per package-lock.json).
 *
 * Pinned to v3 deliberately. Tailwind v4 moved configuration entirely into CSS
 * (`@import "tailwindcss"` + `@theme`), and this project is developed on a
 * machine that cannot run `next build`, so a v3/v4 mismatch would only show up
 * in the Vercel build log. The lockfile pins 3.4.x, so this classic config is
 * the matching one. If the lockfile is ever regenerated and resolves v4, this
 * file silently stops being read — the tell is that the build succeeds and every
 * page renders unstyled.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Security paper. See recourse_design_direction_security_paper.md §2,
        // which supersedes design_spec.md §2. The reference is the faintly
        // patterned stock used on cheques and stock certificates — chosen
        // because it is hard to forge, which is a visual echo of the
        // hash-locked evidence model in docs/DATA_MODEL.md §3. Named for role
        // rather than hue so the palette can move without renaming classNames.
        paper: '#E9F0E2', // pale sage stock
        surface: '#F3F7EE', // card surface, warmer than paper
        ink: {
          DEFAULT: '#1B2620', // deep green-black, deliberately not pure black
          muted: '#4B5A44', // muted sage-gray for secondary text
        },
        rule: '#C9D8BC', // sage hairline — borders AND the security band
        pending: '#8A7A3C', // amber, for procedural "waiting" states only
        // Burgundy rubber-stamp ink. One hue covers both "being contested" and
        // "a refund happened": the stamp's own text and the money split already
        // separate partial from full, so the old second refund hue was noise.
        contested: '#7A2331',
        release: '#2F6B4F', // met / released to the seller
        accent: '#1F3A5F', // plain text links only — buttons no longer use it
      },
      fontFamily: {
        // A document/legal register for headings; the system stack for body.
        // No webfont: one less network dependency in a live demo, and Next's
        // font loader would be another thing to misconfigure unbuilt.
        display: ['Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Georgia', 'Times New Roman', 'serif'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', 'monospace'],
      },
      borderRadius: {
        // Minimally rounded. The default scale is the rounded-SaaS-card look
        // the design spec explicitly rules out.
        none: '0',
        card: '3px',
        control: '2px',
      },
      spacing: {
        // Base unit is 8px; these are the few steps the layout actually uses.
        section: '2.5rem',
      },
      maxWidth: {
        // A document reads at a measure, not at a viewport width.
        measure: '68ch',
        page: '60rem',
      },
    },
  },
  plugins: [],
};
