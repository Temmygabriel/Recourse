/**
 * The slice of RecourseEscrow the UI touches, transcribed from
 * contracts/src/RecourseEscrow.sol.
 *
 * `as const` is load-bearing: it is what lets viem infer the argument and return
 * types of every call below instead of falling back to `any`. Without it, a
 * typo in a function name or a missing argument is a runtime failure in the
 * browser rather than a red squiggle.
 *
 * Field order in `purchaseComponents` must match the struct in the contract
 * exactly — ABI decoding is positional, so reordering these silently swaps
 * values rather than erroring.
 */

/** Mirrors `enum Stage`. Order is load-bearing. */
export const STAGE = {
  NONE: 0,
  OPEN: 1,
  FUNDED: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
} as const;

export type StageValue = (typeof STAGE)[keyof typeof STAGE];

/** Mirrors `enum Outcome`. Order is load-bearing — it is signed into the verdict. */
export const OUTCOME = {
  RELEASE: 0,
  PARTIAL_REFUND: 1,
  FULL_REFUND: 2,
  UNDETERMINED: 3,
} as const;

export type OutcomeValue = (typeof OUTCOME)[keyof typeof OUTCOME];

/** Struct fields in declaration order. See the note above about ordering. */
const purchaseComponents = [
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
  // --- Reads -------------------------------------------------------------
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
    name: 'reviewDeadline',
    stateMutability: 'view',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'disputeBond',
    stateMutability: 'view',
    inputs: [{ name: 'price', type: 'uint96' }],
    outputs: [{ name: '', type: 'uint96' }],
  },
  {
    type: 'function',
    name: 'usdc',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
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
    name: 'MIN_CRITERIA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'MAX_CRITERIA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'BPS_DENOMINATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },

  // --- Writes ------------------------------------------------------------
  {
    type: 'function',
    name: 'createOffer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'price', type: 'uint96' },
      { name: 'deliveryDeadline', type: 'uint64' },
      { name: 'reviewWindow', type: 'uint64' },
      { name: 'promiseText', type: 'string' },
      { name: 'rubric', type: 'string[]' },
    ],
    outputs: [{ name: 'purchaseId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'cancelOffer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'purchase',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submitDelivery',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'purchaseId', type: 'uint256' },
      { name: 'deliveryNotes', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'acceptDelivery',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'openDispute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'purchaseId', type: 'uint256' },
      { name: 'disputedBitmap', type: 'uint8' },
      { name: 'disputeNotes', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimReviewTimeout',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimDeadlineRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'purchaseId', type: 'uint256' }],
    outputs: [],
  },

  // --- Events the UI reads for the activity trail -------------------------
  {
    type: 'event',
    name: 'OfferCreated',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'price', type: 'uint96', indexed: false },
      { name: 'deliveryDeadline', type: 'uint64', indexed: false },
      { name: 'reviewWindow', type: 'uint64', indexed: false },
      { name: 'promiseHash', type: 'bytes32', indexed: false },
      { name: 'rubricHash', type: 'bytes32', indexed: false },
      { name: 'criteriaCount', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Purchased',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'price', type: 'uint96', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DeliverySubmitted',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'deliveryHash', type: 'bytes32', indexed: false },
      { name: 'late', type: 'bool', indexed: false },
    ],
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
  {
    type: 'event',
    name: 'Accepted',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ReviewWindowExpired',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DeadlineRefund',
    inputs: [
      { name: 'purchaseId', type: 'uint256', indexed: true },
      { name: 'buyerAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** ERC-20 surface — the escrow pulls and pushes USDC, the UI only reads it. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/** Decoded `getPurchase` result. */
export interface Purchase {
  seller: `0x${string}`;
  buyer: `0x${string}`;
  price: bigint;
  deliveryDeadline: bigint;
  reviewWindow: bigint;
  deliveredAt: bigint;
  criteriaCount: number;
  stage: number;
  disputeBond: bigint;
  disputedBitmap: number;
  promiseText: string;
  rubric: readonly string[];
  deliveryNotes: string;
  disputeNotes: string;
}
