'use client';

/**
 * The numbered requirements, in the seller's own words.
 *
 * This list is the spine of the product. The buyer reads it before paying
 * (§5.2), the buyer ticks the ones they are disputing (§5.5), and the verdict
 * shows the same numbering back with a mark against each (§5.7). Because the
 * numbers on the verdict have to line up with the numbers the buyer ticked,
 * and with `criteriaMetBitmap` from the `Settled` event, the index is the
 * identity here — the text is never re-numbered or sorted.
 *
 * The text is rendered exactly as stored. No truncation, no capitalization
 * fix-ups, no smart quotes: the rubric hash in the judgment contract is over
 * these bytes (MEMORY.md D12), and a screen that quietly reformats them would
 * be showing the reader something other than what was judged.
 */

import { bitmapFromIndices, requirementLabel } from '@/lib/status';

export type RequirementMark = 'met' | 'unmet' | 'none';

export function RequirementList({
  rubric,
  /** Per-index mark, from `criteriaMetBitmap` on a settled purchase. */
  marks,
  /** Per-index tick state, when the buyer is choosing what to dispute. */
  selected,
  /** Per-index set of criteria the buyer named in the dispute. Display only. */
  disputed,
  onToggle,
  disabled = false,
  caption,
}: {
  rubric: readonly string[];
  marks?: readonly RequirementMark[];
  selected?: ReadonlySet<number>;
  disputed?: ReadonlySet<number>;
  onToggle?: (index: number) => void;
  disabled?: boolean;
  caption?: string;
}) {
  if (rubric.length === 0) return null;

  return (
    <div>
      {caption !== undefined && (
        <p className="mb-1 text-[12px] uppercase tracking-wide text-ink-muted">{caption}</p>
      )}
      <ol className="req-list">
        {rubric.map((text, i) => {
          const mark = marks?.[i] ?? 'none';
          const isSelected = selected?.has(i) ?? false;
          const isDisputed = disputed?.has(i) ?? false;
          const tone =
            mark === 'met' ? ' req-met' : mark === 'unmet' ? ' req-unmet' : '';
          const interactive = onToggle !== undefined;
          return (
            <li
              key={i}
              className={`req${tone}${isSelected || isDisputed ? ' req-selected' : ''}`}
            >
              <span className="req-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="req-text">{text}</span>
              {mark === 'none' && interactive && (
                <input
                  type="checkbox"
                  className="req-check"
                  checked={isSelected}
                  disabled={disabled}
                  onChange={() => onToggle(i)}
                  aria-label={`${requirementLabel(i)}: ${text}`}
                />
              )}
              {mark !== 'none' ? (
                <span className="req-mark" aria-label={mark === 'met' ? 'Met' : 'Not met'}>
                  {mark === 'met' ? 'Met' : 'Not met'}
                </span>
              ) : (
                isDisputed && (
                  <span className="req-mark text-contested" aria-label="Named in the dispute">
                    Disputed
                  </span>
                )
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The buyer's dispute selection, as a bitmap.
 *
 * A thin adapter over `bitmapFromIndices` rather than a second implementation —
 * the bit-twiddling has exactly one home (./status), and this only spares every
 * call site a spread.
 */
export function selectionToBitmap(selected: ReadonlySet<number>): number {
  return bitmapFromIndices([...selected]);
}
