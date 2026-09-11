/**
 * The three icons the home hero needs, plus the wordmark mark.
 *
 * Kept inline and dependency-free on purpose, for the same reason recorded in
 * MEMORY.md D8 (no wagmi, no RainbowKit): four icons do not justify pulling an
 * icon library into a build tree that is otherwise three packages deep. Each
 * one is a single stroked path set on a 24×24 grid, so they stay visually
 * consistent with each other and pick up `currentColor` by default.
 */

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
