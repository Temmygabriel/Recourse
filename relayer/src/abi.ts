/**
 * The subset of RecourseEscrow's ABI the relayer needs.
 *
 * Hand-written rather than generated, deliberately. `contracts/out/` is a build
 * artifact and this repo has no compiler on the development machine, so a
 * generated ABI would either be committed stale or be missing entirely. The
 * tradeoff is that this file can drift from the contract — so every struct here
 * is asserted against the live chain at startup (`assertAbiMatchesChain`), and
 * a mismatch stops the relayer rather than producing a bad decision.
 *
 * Field order is load-bearing: a struct's ABI components must match the
 * declaration order in `RecourseEscrow.sol` exactly, and the enum members are
 * `uint8` here in the same order as `Stage` and `Outcome` there.
 */

export const STAGE = {
  NONE: 0,
  OPEN: 1,
  FUNDED: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
} as const;

export type StageValue = (typeof STAGE)[keyof typeof STAGE];

export const OUTCOME = {
  RELEASE: 0,
  PARTIAL_REFUND: 1,
  FULL_REFUND: 2,
  UNDETERMINED: 3,
} as const;

export type OutcomeValue = (typeof OUTCOME)[keyof typeof OUTCOME];

/** Mirrors the `SettlementDecision` struct in RecourseEscrow.sol, in order. */
export const settlementDecisionComponents = [
  { name: 'purchaseId', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'sourceChainId', type: 'uint256' },
  { name: 'sourceContract', type: 'address' },
  { name: 'genlayerTxHash', type: 'bytes32' },
  { name: 'promiseHash', type: 'bytes32' },
  { name: 'rubricHash', type: 'bytes32' },
  { name: 'evidenceRoot', type: 'bytes32' },
  { name: 'decisionDigest', type: 'bytes32' },
  { name: 'outcome', type: 'uint8' },
  { name: 'refundBps', type: 'uint16' },
  { name: 'criteriaMetBitmap', type: 'uint8' },
  { name: 'finalized', type: 'bool' },
] as const;

/** Mirrors the `Purchase` struct in RecourseEscrow.sol, in order. */
export const purchaseComponents = [
  { name: 'seller', type: 'address' },
  { name: 'buyer', type: 'address' },
  { name: 'price', type: 'uint96' },
  { name: 'deliveryDeadline', type: 'uint64' },
  { name: 'reviewWindow', type: 'uint64' },
  { name: 'deliveredAt', type: 'uint64' },
  { name: 'criteriaCount', type: 'uint8' },
  { name: 'stage', type: 'uint8' },
  { name: 'disputeBond', type: 'uint96' },
  { name: 'disputedBitmap', type: 'uint8' },
  { name: 'promiseText', type: 'string' },
  { name: 'rubric', type: 'string[]' },
  { name: 'deliveryNotes', type: 'string' },
  { name: 'disputeNotes', type: 'string' },
] as const;

export const escrowAbi = [
  {
    type: 'function',
    name: 'getPurchase',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'tuple', components: purchaseComponents }],
  },
  {
    type: 'function',
    name: 'purchaseCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'genlayerKey',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'sourceChainId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'sourceContract',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'relayer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'domainSeparator',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'nonceUsed',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'promiseHash',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'rubricHash',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'deliveryHash',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'disputeHash',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'evidenceRoot',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'hashDecision',
    stateMutability: 'view',
    inputs: [
      { name: 'd', type: 'tuple', components: settlementDecisionComponents },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'd', type: 'tuple', components: settlementDecisionComponents },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'DisputeOpened',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'disputedBitmap', type: 'uint8', indexed: false },
      { name: 'disputeHash', type: 'bytes32', indexed: false },
      { name: 'bond', type: 'uint96', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Settled',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'outcome', type: 'uint8', indexed: false },
      { name: 'refundBps', type: 'uint16', indexed: false },
      { name: 'criteriaMetBitmap', type: 'uint8', indexed: false },
      { name: 'buyerAmount', type: 'uint256', indexed: false },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
      { name: 'bondToBuyer', type: 'uint256', indexed: false },
      { name: 'bondToSeller', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'genlayerTxHash', type: 'bytes32', indexed: false },
      { name: 'decisionDigest', type: 'bytes32', indexed: false },
    ],
  },
] as const;
