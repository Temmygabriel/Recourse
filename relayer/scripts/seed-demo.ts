/**
 * Seed the deployed escrow with one purchase in each stage, for the demo.
 *
 * WHY THIS EXISTS
 *
 * The demo video and the deployed frontend both need content: an offers list
 * with a row in every stage, so a judge can click OPEN → FUNDED → DELIVERED →
 * DISPUTED without first having to play both sides of a trade. Once that content
 * is on chain it is the only copy — there is no way to reconstruct "which
 * promise was number 4" from the contract beyond reading it back. So the exact
 * text, prices and deadlines live here, in the repo, where they can be re-read
 * rather than remembered.
 *
 * WHY THIS IS TYPESCRIPT AND NOT A SHELL SCRIPT
 *
 * `scripts/seed-demo.sh` was the first attempt and it corrupted the data. It
 * passed the rubric to `cast` as `[a,b,c]`, and cast splits that argument on
 * EVERY comma — including commas inside the quoted criteria. Two things
 * happened, and only one of them was loud:
 *
 *   · Offer #3 reverted five times in a row. Its rubric contained "1,100" and
 *     "1,300", so it parsed as five criteria against a maximum of four, and the
 *     contract rejected it. Loud, and cheap: nothing was written.
 *
 *   · Offer #2 SUCCEEDED and was silently wrong. Its rubric contained exactly
 *     one comma, in "all three pages, each with a desktop and a mobile frame.",
 *     so it parsed as four criteria — which passes the ≤4 check — and the first
 *     criterion was stored cut in half at the comma. A rubric is the text a
 *     judgment is made against; an offer whose first criterion is half a
 *     sentence is an offer that cannot be judged as written.
 *
 * The lesson is not "quote it better". It is that a text format where the
 * delimiter is also ordinary punctuation has no safe escaping, and a demo whose
 * contract text is assembled by string-joining is a demo that will lie about
 * itself eventually. viem takes `string[]` as an actual array and ABI-encodes
 * it; no delimiter is ever invented. That is the whole reason this file exists.
 *
 * WHAT IT MAKES
 *
 *   #2  OPEN       the landing-page offer — created by the broken script, left
 *                  alone here (see "THE ONE PURCHASE IT DOES NOT TOUCH")
 *   #3  OPEN       a short blog-post offer, so the list has some variety
 *   #4  FUNDED     bought, awaiting delivery
 *   #5  DELIVERED  delivered, review window still open, so accept-or-dispute
 *                  can be demonstrated live
 *   #6  DISPUTED   disputed on a named criterion; awaiting a judgment
 *
 * Purchase #1 already exists and is SETTLED — it is the one that closed the loop
 * in Session 13. This script does not touch it.
 *
 * THE ONE PURCHASE IT DOES NOT TOUCH
 *
 * #2's rubric is stored split at a comma. It is left as it is, deliberately.
 * `cancelOffer` sets `stage = NONE` but KEEPS `p.seller`, and `fetchAllPurchases`
 * filters on `seller !== ZERO` — so a cancelled offer still appears in the list,
 * rendered by `STAGE_INFO[STAGE.NONE]` as "Not found / No record exists for this
 * purchase." Cancelling would put a visible broken row in the demo to fix a
 * broken sentence in a row that is otherwise coherent. The rubric is wrong; the
 * offer is not.
 *
 * IT IS RESUMABLE, WHICH IS THE POINT
 *
 * The public RPC drops connections and the run takes a couple of minutes, so a
 * seeder that can only run once from an empty escrow is a seeder that leaves the
 * demo half-built and the next attempt fighting it. Every step here reads the
 * chain first and performs only what is missing: an offer whose id already
 * exists is not created again, a purchase that is already FUNDED is not bought
 * again, and a purchase already DISPUTED is left alone. Re-running after a
 * failure continues; re-running after success does nothing at all.
 *
 * SAFETY
 *
 * Base Sepolia only, and it refuses to run against anything else. It writes
 * nothing unless `--broadcast` is passed. Keys are read from ../../.secrets/,
 * which is gitignored and never committed; nothing here prints one.
 *
 * USAGE
 *
 *   cd relayer
 *   node scripts/seed-demo.ts               # read the chain, print the plan
 *   node scripts/seed-demo.ts --broadcast   # actually send
 *   node scripts/seed-demo.ts --inspect     # print every purchase, change nothing
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRETS = resolve(HERE, '../../.secrets');

const RPC = process.env['BASE_RPC_URL'] ?? 'https://sepolia.base.org';
const ESCROW = (process.env['ESCROW_ADDRESS'] ??
  '0x32288128Ff07Fc9e443161c1F336b784508a056A') as Address;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

const transport = http(RPC, { retryCount: 3, timeout: 30_000 });
const publicClient = createPublicClient({ chain: baseSepolia, transport });

// ---------------------------------------------------------------------------
// ABIs. The write surface is declared here rather than widened into the
// relayer's own ABI (src/abi.ts), which is deliberately read-only plus `settle`
// because that is all a relayer does.
// ---------------------------------------------------------------------------

const escrowAbi = parseAbi([
  'function createOffer(uint96 price, uint64 deliveryDeadline, uint64 reviewWindow, string promiseText, string[] rubric) returns (uint256)',
  'function purchase(uint256 purchaseId)',
  'function submitDelivery(uint256 purchaseId, string deliveryNotes)',
  'function openDispute(uint256 purchaseId, uint8 disputedBitmap, string disputeNotes)',
  'function disputeBond(uint96 price) view returns (uint96)',
  'function purchaseCount() view returns (uint256)',
  'function totalHeld() view returns (uint256)',
  'function getPurchase(uint256 purchaseId) view returns ((address seller, address buyer, uint96 price, uint64 deliveryDeadline, uint64 reviewWindow, uint64 deliveredAt, uint8 criteriaCount, uint8 stage, uint96 disputeBond, uint8 disputedBitmap, string promiseText, string[] rubric, string deliveryNotes, string disputeNotes))',
]);

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

interface Wallet {
  readonly name: string;
  readonly address: Address;
  readonly client: ReturnType<typeof createWalletClient>;
}

function loadWallet(name: string): Wallet {
  const raw = JSON.parse(readFileSync(resolve(SECRETS, `${name}.json`), 'utf8')) as {
    address: Address;
    privateKey: string;
  };
  const account = privateKeyToAccount(
    (raw.privateKey.startsWith('0x') ? raw.privateKey : `0x${raw.privateKey}`) as Hex,
  );
  const client = createWalletClient({ account, chain: baseSepolia, transport });
  return { name, address: account.address, client };
}

// ---------------------------------------------------------------------------
// Helpers — the same conventions as e2e-live.ts, deliberately. Two scripts that
// talk to the same chain should fail the same way.
// ---------------------------------------------------------------------------

const STAGE = ['NONE', 'OPEN', 'FUNDED', 'DELIVERED', 'DISPUTED', 'SETTLED'] as const;
type Stage = (typeof STAGE)[number];

/** How far along the state machine a stage is, so "drive it to X" is a number. */
const RANK: Record<Stage, number> = {
  NONE: 0,
  OPEN: 1,
  FUNDED: 2,
  DELIVERED: 3,
  DISPUTED: 4,
  SETTLED: 5,
};

function hr(label: string): void {
  console.log(`\n${'─'.repeat(72)}\n${label}\n${'─'.repeat(72)}`);
}

function usdc(v: bigint): string {
  return `${formatUnits(v, 6)} USDC`;
}

/** Raised only when a transaction was mined and reverted. Never retried. */
class MinedRevert extends Error {}

/**
 * Send, wait, and surface the revert reason.
 *
 * A failure that never reached the chain is retried; a failure that DID reach
 * the chain is not, because re-sending a mined revert only burns gas
 * reproducing it. See e2e-live.ts for the full account of why — the short
 * version is that Base Sepolia's public RPC fronts several nodes with lagging
 * views, so `eth_estimateGas` can revert against a node that has not yet seen
 * the approval the previous transaction just mined.
 */
async function send(
  wallet: Wallet,
  address: Address,
  abi: readonly unknown[],
  functionName: string,
  args: readonly unknown[],
): Promise<void> {
  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const hash = await wallet.client.writeContract({
        address,
        abi: abi as never,
        functionName: functionName as never,
        args: args as never,
        chain: baseSepolia,
        account: wallet.client.account!,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') {
        throw new MinedRevert(`reverted in block ${receipt.blockNumber} (tx ${hash})`);
      }
      console.log(
        `  ✓ ${functionName}  tx ${hash.slice(0, 18)}…` +
          (attempt > 1 ? `  (attempt ${attempt})` : ''),
      );
      return;
    } catch (e) {
      if (e instanceof MinedRevert) throw e;

      const msg = e instanceof Error ? e.message : String(e);
      const reason = msg
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.endsWith('reason:'))
        .join(' ');

      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`${functionName} failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
      }
      console.log(`  · ${functionName}: attempt ${attempt} reverted pre-broadcast, retrying…`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}

async function allowanceOf(owner: Address): Promise<bigint> {
  return publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, ESCROW],
  });
}

async function approveIfNeeded(wallet: Wallet, needed: bigint, label: string): Promise<void> {
  if (needed === 0n) return;
  const current = await allowanceOf(wallet.address);
  if (current >= needed) {
    console.log(`  · ${label}: allowance already ${usdc(current)}, no approval needed`);
    return;
  }
  // The exact amount, never unlimited. The escrow is immutable and unaudited;
  // an infinite approval is a standing risk with no upside on a testnet demo.
  await send(wallet, USDC, erc20Abi, 'approve', [ESCROW, needed]);
  console.log(`  · ${label}: approved ${usdc(needed)}`);
}

async function readPurchase(id: bigint) {
  return publicClient.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'getPurchase',
    args: [id],
  });
}

async function purchaseCount(): Promise<bigint> {
  return publicClient.readContract({
    address: ESCROW,
    abi: escrowAbi,
    functionName: 'purchaseCount',
  });
}

async function stageOf(id: bigint): Promise<Stage> {
  const p = await readPurchase(id);
  return STAGE[p.stage] ?? 'NONE';
}

/**
 * Poll until a read reflects the state a transaction just produced.
 *
 * `getPurchase()` is answered by whichever node the RPC's load balancer picks,
 * and one of them can be seconds behind the block our transaction landed in.
 * Observed live: `openDispute` was mined, the escrow's USDC balance rose, and a
 * read a moment later still reported DELIVERED with a zero bond. The contract
 * was right; the reader was behind. Waiting for more confirmations does not fix
 * it — polling until the value is what the transaction produced does, and it
 * fails loudly instead of printing a stale answer that reads like a contract bug.
 */
async function waitForStage(id: bigint, expected: Stage, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen: Stage = 'NONE';
  for (;;) {
    seen = await stageOf(id);
    if (seen === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `purchase ${id} is still ${seen} after ${timeoutMs}ms; expected ${expected}. ` +
          `The transaction WAS mined — re-run with --inspect to confirm. ` +
          `This is the public RPC lagging, not the contract.`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// ---------------------------------------------------------------------------
// The content
// ---------------------------------------------------------------------------

const NOW = BigInt(Math.floor(Date.now() / 1000));
const DELIVERY_DEADLINE = NOW + 3n * 86_400n; // 3 days out
const REVIEW_WINDOW = 172_800n; // 2 days, inside the [1 hour, 30 days] bound

/**
 * One slot per purchase id, and how far to drive it.
 *
 * Rubrics are three criteria each. That is not stylistic: the judgment takes the
 * buyer's disputed bitmap over these exact indices, and a criterion the demo
 * cannot point at is a criterion the demo cannot dispute.
 */
interface Slot {
  readonly id: number;
  readonly target: Stage;
  readonly price: bigint;
  readonly subject: string;
  readonly promise: string;
  readonly rubric: readonly string[];
  readonly delivery?: string;
  readonly dispute?: { readonly bitmap: number; readonly notes: string };
}

const SLOTS: readonly Slot[] = [
  {
    id: 3,
    target: 'OPEN',
    price: 1_500_000n,
    subject: 'blog post',
    promise:
      'I will write and deliver a 1,200-word technical blog post explaining your escrow ' +
      'contract to a non-technical audience, with a diagram of the payment flow.',
    rubric: [
      'The post is between 1,100 and 1,300 words.',
      'It contains at least one diagram illustrating the payment flow.',
      'No sentence assumes the reader already knows what a smart contract is.',
    ],
  },
  {
    id: 4,
    target: 'FUNDED',
    price: 4_000_000n,
    subject: 'screen recording',
    promise:
      'I will record and deliver a 90-second screen-recorded walkthrough of your dashboard, ' +
      'with narration, as a 1080p MP4 file.',
    rubric: [
      'The recording is between 85 and 95 seconds long.',
      'Every click described in the narration is visible in the recording.',
      'The file is delivered as an H.264 MP4 at 1080p.',
    ],
  },
  {
    id: 5,
    target: 'DELIVERED',
    price: 2_500_000n,
    subject: 'accessibility audit',
    promise:
      'I will audit your landing page for accessibility and deliver a written report naming ' +
      'every WCAG 2.2 AA failure I find, with the element and the fix for each.',
    rubric: [
      'Every failure listed names the specific element it applies to.',
      'Each entry gives the WCAG 2.2 AA success criterion it fails.',
      'The report is delivered as a single Markdown file.',
    ],
    // Deliberately imperfect, and it names its own shortfall: two of the twelve
    // entries name a component rather than an element. A delivery the buyer
    // could reasonably dispute is a delivery worth having in the demo — it is
    // what the accept/reject screen is for.
    delivery:
      'Delivered accessibility-report.md. Twelve failures listed, each with the element and ' +
      'the WCAG criterion. Two of the twelve name the component rather than the element, and ' +
      'the report does not say which file the component lives in.',
  },
  {
    id: 6,
    target: 'DISPUTED',
    price: 2_000_000n,
    subject: 'Postgres backups',
    promise:
      'I will set up and hand over a nightly Postgres backup job for your staging environment, ' +
      'with a 14-day retention window and tested restore instructions.',
    rubric: [
      'A nightly job exists and has produced at least one successful backup.',
      'Backups older than 14 days are deleted automatically.',
      'Restore instructions are documented and were tested against a real backup.',
    ],
    delivery:
      'Delivered backup-setup.md and the cron entry. The nightly job has run twice; the ' +
      'retention script is in place. Restore instructions are written up in full.',
    // Bitmap 4 = 0b100 = bit index 2 = the third criterion, counting from zero.
    // The indices are the seller's own frozen rubric, which is the point of the
    // bitmap: the buyer names a criterion that existed before the delivery did.
    dispute: {
      bitmap: 4,
      notes:
        'Criterion 3 was not met. The restore instructions are documented, but the restore ' +
        'was only run against a copy of a backup file on the same machine, never against a ' +
        'real backup. Criterion 1 and 2 were met.',
    },
  },
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * The stored rubric must be the rubric that was written.
 *
 * This is the check the shell script needed and did not have. It compares the
 * array the contract gives back against the array above, item for item and in
 * order, and names the first difference. A rubric that silently lost a clause is
 * not detectable by reading the offer — it looks like a slightly terse criterion
 * — so the only way to know is to compare it against the source.
 */
function assertRubric(slot: Slot, stored: readonly string[]): void {
  if (stored.length !== slot.rubric.length) {
    throw new Error(
      `#${slot.id}: stored rubric has ${stored.length} criteria, expected ${slot.rubric.length}.\n` +
        `  stored: ${JSON.stringify(stored)}`,
    );
  }
  for (let i = 0; i < stored.length; i++) {
    if (stored[i] !== slot.rubric[i]) {
      throw new Error(
        `#${slot.id}: criterion ${i} does not match.\n` +
          `  stored:   ${JSON.stringify(stored[i])}\n` +
          `  expected: ${JSON.stringify(slot.rubric[i])}`,
      );
    }
  }
}

/** Create the offer for a slot if it is not already on chain. */
async function ensureOffer(
  slot: Slot,
  count: bigint,
  seller: Wallet,
  broadcast: boolean,
): Promise<bigint> {
  if (BigInt(slot.id) <= count) {
    const p = await readPurchase(BigInt(slot.id));
    if (p.seller.toLowerCase() !== seller.address.toLowerCase()) {
      throw new Error(
        `#${slot.id} already exists and its seller is ${p.seller}, not ${seller.address}. ` +
          `Refusing to build the demo on top of a purchase this script did not create.`,
      );
    }
    assertRubric(slot, p.rubric);
    console.log(`  ✓ #${slot.id} exists — ${usdc(p.price)}, ${p.criteriaCount} criteria, rubric verified`);
    return count;
  }

  const next = count + 1n;
  if (BigInt(slot.id) !== next) {
    throw new Error(
      `#${slot.id} does not exist, but the next id the contract will hand out is ${next}. ` +
        `Ids are assigned sequentially, so this script's plan and the chain disagree. ` +
        `Run with --inspect to see what is actually there.`,
    );
  }

  console.log(`  + #${slot.id} createOffer — ${usdc(slot.price)}, ${slot.subject}`);
  // A plan run still has to advance the count it hands to the next slot. The
  // ids are sequential, so returning the unchanged count would make slot #4
  // report a disagreement with the chain over an offer #3 was never going to
  // create — a plan that contradicts itself rather than a plan about a chain.
  if (!broadcast) return next;

  await send(seller, ESCROW, escrowAbi, 'createOffer', [
    slot.price,
    DELIVERY_DEADLINE,
    REVIEW_WINDOW,
    slot.promise,
    slot.rubric,
  ]);
  await waitForStage(BigInt(slot.id), 'OPEN');

  // Read it straight back. A createOffer that mined is not evidence that the
  // rubric was stored as written — that is exactly the assumption that let the
  // shell script store a half-sentence criterion.
  const p = await readPurchase(BigInt(slot.id));
  assertRubric(slot, p.rubric);
  console.log(`  ✓ #${slot.id} rubric verified on chain (${p.criteriaCount} criteria)`);

  return next;
}

/**
 * Walk a slot's remaining steps without sending anything, for a plan run.
 *
 * Needed because a plan run has no stage to read: an offer that "would have
 * been" created a moment ago is not on chain, so `getPurchase` has nothing to
 * say about it. The bond is the one value that can still be read for real,
 * because `disputeBond` is a pure function of the price.
 */
async function project(slot: Slot, id: bigint): Promise<void> {
  if (RANK[slot.target] >= RANK.FUNDED) {
    console.log(`  + #${slot.id} purchase — ${usdc(slot.price)} from the buyer`);
  }
  if (RANK[slot.target] >= RANK.DELIVERED && slot.delivery !== undefined) {
    console.log(`  + #${slot.id} submitDelivery`);
  }
  if (RANK[slot.target] >= RANK.DISPUTED && slot.dispute !== undefined) {
    const bond = await publicClient.readContract({
      address: ESCROW,
      abi: escrowAbi,
      functionName: 'disputeBond',
      args: [slot.price],
    });
    console.log(
      `  + #${slot.id} openDispute — bond ${usdc(bond)}, bitmap ` +
        `0b${slot.dispute.bitmap.toString(2).padStart(slot.rubric.length, '0')}`,
    );
  }
}

/** Drive one purchase up to its target stage, doing only the missing steps. */
async function driveTo(
  slot: Slot,
  seller: Wallet,
  buyer: Wallet,
  broadcast: boolean,
  existed: boolean,
): Promise<void> {
  const id = BigInt(slot.id);

  // A plan run cannot read a stage for a purchase that is not there. Rather
  // than pretend, the remaining steps are printed as what they are: a plan.
  if (!broadcast && !existed) {
    await project(slot, id);
    return;
  }

  const at = await stageOf(id);
  const want = RANK[slot.target];

  if (RANK[at] >= want) {
    console.log(`  ✓ #${slot.id} already ${at}`);
    return;
  }

  // --- purchase -----------------------------------------------------------
  if (RANK[at] < RANK.FUNDED) {
    const p = await readPurchase(id);
    console.log(`  + #${slot.id} purchase — ${usdc(p.price)} from the buyer`);
    if (broadcast) {
      await approveIfNeeded(buyer, p.price, 'price');
      await send(buyer, ESCROW, escrowAbi, 'purchase', [id]);
      await waitForStage(id, 'FUNDED');
    }
  }

  // --- deliver ------------------------------------------------------------
  if (want >= RANK.DELIVERED) {
    const now = await stageOf(id);
    if (RANK[now] < RANK.DELIVERED) {
      if (slot.delivery === undefined) {
        throw new Error(`#${slot.id} must reach DELIVERED but the plan has no delivery text.`);
      }
      console.log(`  + #${slot.id} submitDelivery`);
      if (broadcast) {
        await send(seller, ESCROW, escrowAbi, 'submitDelivery', [id, slot.delivery]);
        await waitForStage(id, 'DELIVERED');
      }
    }
  }

  // --- dispute ------------------------------------------------------------
  if (want >= RANK.DISPUTED) {
    const now = await stageOf(id);
    if (RANK[now] < RANK.DISPUTED) {
      if (slot.dispute === undefined) {
        throw new Error(`#${slot.id} must reach DISPUTED but the plan has no dispute text.`);
      }
      const p = await readPurchase(id);
      const bond = await publicClient.readContract({
        address: ESCROW,
        abi: escrowAbi,
        functionName: 'disputeBond',
        args: [p.price],
      });
      console.log(
        `  + #${slot.id} openDispute — bond ${usdc(bond)}, bitmap ` +
          `0b${slot.dispute.bitmap.toString(2).padStart(p.criteriaCount, '0')}`,
      );
      if (broadcast) {
        await approveIfNeeded(buyer, bond, 'bond');
        await send(buyer, ESCROW, escrowAbi, 'openDispute', [
          id,
          slot.dispute.bitmap,
          slot.dispute.notes,
        ]);
        await waitForStage(id, 'DISPUTED');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function inspect(): Promise<void> {
  const count = await purchaseCount();
  hr(`Escrow ${ESCROW}`);
  console.log(`  chain           ${baseSepolia.id}`);
  console.log(`  purchases       ${count}`);
  for (let i = 0n; i <= count; i++) {
    const p = await readPurchase(i);
    const stage = STAGE[p.stage] ?? String(p.stage);
    console.log(
      `\n  #${i}  ${stage.padEnd(9)} ${usdc(p.price).padStart(12)}  ` +
        `${p.criteriaCount} criteria  seller ${p.seller.slice(0, 10)}…`,
    );
    if (i === 0n) continue;
    for (const [n, criterion] of p.rubric.entries()) {
      const bit = (p.disputedBitmap >> n) & 1;
      console.log(`      ${bit === 1 ? '⚑' : ' '} [${n}] ${criterion}`);
    }
    if (p.deliveryNotes.length > 0) {
      console.log(`      delivery: ${p.deliveryNotes.slice(0, 96)}…`);
    }
    if (p.disputeNotes.length > 0) {
      console.log(`      dispute:  ${p.disputeNotes.slice(0, 96)}…`);
    }
  }
  const [held, escrowUsdc] = await Promise.all([
    publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'totalHeld' }),
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ESCROW],
    }),
  ]);
  console.log(`\n  totalHeld()     ${usdc(held)}`);
  console.log(`  USDC at escrow  ${usdc(escrowUsdc)}`);
  console.log(
    held === escrowUsdc
      ? `  ✓ the escrow's books reconcile with its balance`
      : `  ✗ RECONCILIATION FAILURE — held ${usdc(held)} but holds ${usdc(escrowUsdc)}`,
  );
}

async function main(): Promise<void> {
  const broadcast = process.argv.includes('--broadcast');

  if (process.argv.includes('--inspect')) {
    await inspect();
    return;
  }

  // --- preflight ----------------------------------------------------------
  hr('Preflight');
  const chainId = await publicClient.getChainId();
  if (chainId !== baseSepolia.id) {
    throw new Error(
      `Refusing to run: the RPC reports chain ${chainId}, expected ${baseSepolia.id}. ` +
        `This script only ever writes to Base Sepolia.`,
    );
  }

  const seller = loadWallet('deployer');
  const buyer = loadWallet('demo');

  let count = await purchaseCount();
  const [held, buyerUsdc] = await Promise.all([
    publicClient.readContract({ address: ESCROW, abi: escrowAbi, functionName: 'totalHeld' }),
    publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [buyer.address],
    }),
  ]);

  console.log(`  chain           ${chainId}`);
  console.log(`  escrow          ${ESCROW}`);
  console.log(`  seller          ${seller.address}  (deployer.json)`);
  console.log(`  buyer           ${buyer.address}  (demo.json)`);
  console.log(`  purchases now   ${count}`);
  console.log(`  totalHeld()     ${usdc(held)}`);
  console.log(`  buyer USDC      ${usdc(buyerUsdc)}`);
  console.log(`  mode            ${broadcast ? 'BROADCAST' : 'plan only — nothing will be sent'}`);

  // --- create and drive ---------------------------------------------------
  //
  // Interleaved rather than two passes, because whether a slot needs a purchase
  // depends on whether it was already there when the run started — and after
  // `ensureOffer` has created it, it is there either way. `existed` is captured
  // before that, which is the only moment the answer is still true.
  hr('Offers and lifecycle');
  for (const slot of SLOTS) {
    const existed = BigInt(slot.id) <= count;
    count = await ensureOffer(slot, count, seller, broadcast);
    await driveTo(slot, seller, buyer, broadcast, existed);
  }

  if (!broadcast) {
    hr('Plan only. Nothing was sent. Re-run with --broadcast to send.');
    return;
  }

  // --- summary -----------------------------------------------------------
  await inspect();
}

await main();
