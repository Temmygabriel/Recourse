/**
 * What each state is called on screen, and what the app says about it.
 *
 * All user-facing wording for stages, outcomes and the standing explainers lives
 * here rather than inline in the JSX, because the copy rules in design spec §6
 * are constraints, not style notes: plain consumer-protection language, specific
 * over formal, and no "AI-powered / decentralized / validator-secured" as a
 * trust pitch. One file to review against that list beats sixty strings spread
 * across eight screens.
 *
 * Where a screen needs to say that GenLayer decided (design spec §5.7 requires
 * it plainly, so a reader does not think a human reviewed their case), the
 * wording names GenLayer's validator network and stops there. The trust pitch
 * this product actually makes is the visible chain — promise, evidence, finding,
 * money — and the copy keeps pointing at that instead.
 */

import { OUTCOME, STAGE, type OutcomeValue, type StageValue } from './abi';

// --- Stages ----------------------------------------------------------------

export interface StageInfo {
  /** The state's name as a buyer would say it, not as the enum spells it. */
  label: string;
  /** One line on what is happening now. */
  blurb: string;
  tone: 'neutral' | 'pending' | 'release' | 'partial' | 'refund';
}

const STAGE_INFO: Record<StageValue, StageInfo> = {
  [STAGE.NONE]: {
    label: 'Not found',
    blurb: 'No record exists for this purchase.',
    tone: 'neutral',
  },
  [STAGE.OPEN]: {
    label: 'Offer open',
    blurb: 'This promise is published and waiting for a buyer.',
    tone: 'neutral',
  },
  [STAGE.FUNDED]: {
    label: 'Paid — awaiting delivery',
    blurb: 'The buyer has paid. The money is held until delivery is confirmed or the deadline passes.',
    tone: 'pending',
  },
  [STAGE.DELIVERED]: {
    label: 'Delivered — review window open',
    blurb: 'The seller has submitted what they delivered. The buyer can accept it or dispute a specific requirement.',
    tone: 'pending',
  },
  [STAGE.DISPUTED]: {
    label: 'In dispute',
    blurb: "The buyer says part of the promise wasn't kept. GenLayer's validator network is comparing the promise against the evidence.",
    tone: 'pending',
  },
  [STAGE.SETTLED]: {
    label: 'Settled',
    blurb: 'This purchase is closed and the money has moved.',
    tone: 'neutral',
  },
};

export function stageInfo(stage: number): StageInfo {
  return STAGE_INFO[stage as StageValue] ?? STAGE_INFO[STAGE.NONE];
}

/** Can the review window still be acted on? Uses the contract's own deadline. */
export function isReviewOpen(p: { deliveredAt: bigint; reviewWindow: bigint }, now = Date.now()): boolean {
  if (p.deliveredAt === 0n) return false;
  return BigInt(Math.floor(now / 1000)) <= p.deliveredAt + p.reviewWindow;
}

export function reviewDeadlineOf(p: { deliveredAt: bigint; reviewWindow: bigint }): bigint {
  return p.deliveredAt === 0n ? 0n : p.deliveredAt + p.reviewWindow;
}

// --- Outcomes --------------------------------------------------------------

export interface OutcomeInfo {
  /** Sentence case. Used wherever the outcome is a label. */
  label: string;
  /** The loud variant, used for the stamp mark only. */
  stamp: string;
  /** Which stamp/status colour class to apply. */
  tone: 'release' | 'partial' | 'refund' | 'neutral';
}

const OUTCOME_INFO: Record<OutcomeValue, OutcomeInfo> = {
  [OUTCOME.RELEASE]: { label: 'Released to seller', stamp: 'Released', tone: 'release' },
  [OUTCOME.PARTIAL_REFUND]: { label: 'Partial refund', stamp: 'Partial refund', tone: 'partial' },
  [OUTCOME.FULL_REFUND]: { label: 'Full refund', stamp: 'Full refund', tone: 'refund' },
  [OUTCOME.UNDETERMINED]: { label: 'Undetermined', stamp: 'Undetermined', tone: 'neutral' },
};

export function outcomeInfo(outcome: number): OutcomeInfo {
  return OUTCOME_INFO[outcome as OutcomeValue] ?? OUTCOME_INFO[OUTCOME.UNDETERMINED];
}

// --- Verdict line ----------------------------------------------------------

/**
 * The one-sentence finding, in the shape design spec §6 asks for:
 *
 *   "Partial refund — the delivery met 2 of 3 requirements you agreed to at
 *   purchase."
 *
 * Never a confidence score. The count of met requirements is a fact about the
 * evidence, and it is the fact the buyer already has the context to check,
 * because those requirements are the same numbered list they read before paying.
 */
export function verdictLine(args: {
  outcome: number;
  criteriaMet: readonly boolean[];
}): string {
  const met = args.criteriaMet.filter(Boolean).length;
  const total = args.criteriaMet.length;
  const info = outcomeInfo(args.outcome);

  switch (args.outcome) {
    case OUTCOME.RELEASE:
      return `${info.label} — the delivery met all ${total} requirements you agreed to at purchase.`;
    case OUTCOME.PARTIAL_REFUND:
      return `${info.label} — the delivery met ${met} of ${total} requirements you agreed to at purchase.`;
    case OUTCOME.FULL_REFUND:
      return `${info.label} — none of the ${total} requirements you agreed to at purchase were met.`;
    default:
      return `${info.label} — the evidence wasn't enough to decide whether the promise was kept, so the buyer's money is returned and the bond goes back.`;
  }
}

/** How much of the price the buyer gets back, for a given bps. */
export function refundDescription(refundBps: number): string {
  if (refundBps === 0) return 'Nothing is refunded; the seller keeps the payment.';
  if (refundBps === 10_000) return 'The full payment is returned to the buyer.';
  const pct = (refundBps / 100).toFixed(refundBps % 100 === 0 ? 0 : 1);
  return `${pct}% of the payment is returned to the buyer; the seller keeps the rest.`;
}

// --- Standing explainers ---------------------------------------------------

/**
 * Design spec §5.2: explain escrow once, at the moment of payment, not as an
 * upfront tutorial.
 */
export const ESCROW_EXPLAINER =
  'Your payment is held until you confirm delivery or a dispute is resolved — ' +
  'the seller can’t access it before then.';

/** Design spec §6, the evidence ask. */
export const EVIDENCE_ASK = 'Show us what was promised and what you received.';

/** Design spec §6, the dispute prompt. */
export const DISPUTE_PROMPT = "Which part of the promise wasn’t kept?";

/** Design spec §5.5, shown before the buyer confirms a dispute. */
export const BOND_RETURNED_NOTE =
  'If GenLayer agrees with you, this bond is returned. If the delivery is found to ' +
  'have met every requirement, the bond goes to the seller.';

/**
 * Design spec §5.7: say plainly who decided. Names the validator network and
 * does not imply a person reviewed the case, and does not invent a reviewer.
 */
export const WHO_DECIDED_NOTE =
  "This finding was produced by GenLayer’s validator network comparing the " +
  'promise, the criteria and the evidence you can see on this page. No person ' +
  'reviewed this case.';

/** Design spec §4.4 / build spec §4.4: wallet activity is fact, not identity. */
export const WALLET_IS_NOT_IDENTITY_NOTE =
  'Wallet addresses are not identity checks — the same person can have many, and ' +
  'several people can share one. Activity is shown as a fact, not a trust score.';

/** Build spec §4.1 requires this to be stated, in the UI and the README. */
export const TRUST_BOUNDARY_NOTE =
  'The relayer that carries a verdict from GenLayer to Base is a trusted prototype ' +
  'component. This is a testnet build and no real funds are involved.';

// --- Bits and criteria -----------------------------------------------------

/** Indices set in a bitmap, as 0-based criterion indices. */
export function bitmapIndices(bitmap: number, criteriaCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < criteriaCount; i++) {
    if ((bitmap & (1 << i)) !== 0) out.push(i);
  }
  return out;
}

export function bitmapFromIndices(indices: readonly number[]): number {
  return indices.reduce((acc, i) => acc | (1 << i), 0);
}

/** "Requirement 2", 1-based for display against the seller's numbered list. */
export function requirementLabel(zeroBased: number): string {
  return `Requirement ${zeroBased + 1}`;
}
