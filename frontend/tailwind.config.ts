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
        // Design spec §2. Light neutral surfaces, strong black type. Named for
        // their role rather than their hue, so the palette can move without
        // renaming every className.
        paper: '#FAFAF8',
        surface: '#FFFFFF',
        ink: {
          DEFAULT: '#16161A',
          muted: '#5B5B63',
        },
        rule: '#E4E4E0',
        // Restrained status colours — deliberately not a neon palette.
        pending: '#8A7A3C',
        release: '#2F6B4F',
        partial: '#8A5A2B',
        refund: '#7A3B3B',
        accent: '#1F3A5F',
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
