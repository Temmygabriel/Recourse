/**
 * Live end-to-end driver: drives one purchase through the whole escrow state
 * machine on Base Sepolia, and stops where the relayer takes over.
 *
 * WHY THIS EXISTS
 *
 * Both contracts are deployed and their wiring is verified, but nothing has
 * ever exercised the path that actually moves money. This script walks a real
 * purchase — as two different wallets — from `createOffer` to `DISPUTED`, so
 * that the relayer has a real case to carry and the escrow's own hashes,
 * bonds and stage transitions get tested against a live chain rather than
 * only against Foundry's in-memory EVM.
 *
 * It deliberately STOPS at DISPUTED. Everything past that point is the
 * relayer's job (`DRY_RUN=true node dist/index.js`), and running it here would
 * duplicate the component under test.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 *
 * Proves: the escrow accepts the flow, pulls the right USDC amounts, computes
 * its commitments, and reaches DISPUTED with a bond held. It also prints the
 * values the relayer will have to reproduce independently — `genlayerKey`,
 * `evidenceRoot`, `promiseHash`, `rubricHash` — so a mismatch there is visible
 * before any GenLayer fee is spent.
 *
 * Does NOT prove: that a verdict can travel back. That is the relayer run.
 *
 * USAGE
 *
 *   cd relayer
 *   node scripts/e2e-live.ts                 # full run
 *   node scripts/e2e-live.ts --inspect 3     # just print purchase 3
 *
 * Wallets come from ../.secrets/, which is gitignored. Nothing here ever
 * prints a private key.
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
// The lifecycle writes. The relayer's own ABI (src/abi.ts) is deliberately
// read-only plus `settle`, because that is all a relayer does — so the buyer
// and seller calls are declared here rather than widened into shipped code.
// ---------------------------------------------------------------------------

const escrowWriteAbi = parseAbi([
  'function createOffer(uint96 price, uint64 deliveryDeadline, uint64 reviewWindow, string promiseText, string[] rubric) returns (uint256)',
  'function purchase(uint256 purchaseId)',
  'function submitDelivery(uint256 purchaseId, string deliveryNotes)',
  'function openDispute(uint256 purchaseId, uint8 disputedBitmap, string disputeNotes)',
  'function disputeBond(uint96 price) view returns (uint96)',
  'function purchaseCount() view returns (uint256)',
  'function totalHeld() view returns (uint256)',
  'function getPurchase(uint256 purchaseId) view returns ((address seller, address buyer, uint96 price, uint64 deliveryDeadline, uint64 reviewWindow, uint64 deliveredAt, uint8 criteriaCount, uint8 stage, uint96 disputeBond, uint8 disputedBitmap, string promiseText, string[] rubric, string deliveryNotes, string disputeNotes))',
  'function genlayerKey(uint256 purchaseId) view returns (string)',
  'function promiseHash(uint256 purchaseId) view returns (bytes32)',
  'function rubricHash(uint256 purchaseId) view returns (bytes32)',
  'function evidenceRoot(uint256 purchaseId) view returns (bytes32)',
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
// Helpers
// ---------------------------------------------------------------------------

const STAGE = ['NONE', 'OPEN', 'FUNDED', 'DELIVERED', 'DISPUTED', 'SETTLED'] as const;

function hr(label: string): void {
  console.log(`\n${'─'.repeat(72)}\n${label}\n${'─'.repeat(72)}`);
}

function usdc(v: bigint): string {
  return `${formatUnits(v, 6)} USDC`;
}

/**
 * Send, wait, and surface the revert reason.
 *
 * viem's `writeContract` calls `eth_estimateGas` first, so a revert surfaces
 * here as a thrown error WITH the contract's own reason string — which is the
 * whole point. A bare "transaction failed" would be useless for the 16-item
 * rejection list in `settle()`.
 */
/** Raised only when a transaction was mined and reverted. Never retried. */
class MinedRevert extends Error {}

/**
 * Send, wait, and surface the revert reason.
 *
 * TWO THINGS THIS HANDLES THAT A NAIVE `writeContract` DOES NOT.
 *
 * 1.  STALE STATE AT ESTIMATE TIME. viem calls `eth_estimateGas` before it
 *     broadcasts, so the estimate is evaluated by whichever node the RPC's
 *     load balancer picked. Base Sepolia's public RPC fronts several nodes
 *     with lagging views, and an approval that was confirmed seconds ago can
 *     be invisible to the node that estimates the next call. That produces a
 *     revert — typically `transferFrom failed` on the call right after an
 *     `approve` — for a transaction that would have succeeded.
 *
 *     Observed live: `purchase` succeeded, then `openDispute` reverted with
 *     `transferFrom failed`, and the exact same call simulated cleanly the
 *     moment it was retried. Nothing was wrong with the contracts or the
 *     allowance.
 *
 *     So a failure that never reached the chain is retried a few times. A
 *     failure that DID reach the chain is not: re-sending a mined revert just
 *     burns gas reproducing it, and for a state-changing call it risks doing
 *     the thing twice.
 *
 * 2.  THE REVERT REASON. viem puts the contract's own reason on the SECOND
 *     line of its error, after the "reverted with the following reason:"
 *     header. Taking only the first line — as an earlier version of this file
 *     did — prints an empty reason and throws away the one piece of
 *     information a revert exists to give you.
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
        `  ✓ ${functionName}  ${wallet.name}  gas ${receipt.gasUsed}  tx ${hash.slice(0, 18)}…` +
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
        throw new Error(
          `${functionName} failed for ${wallet.name} after ${MAX_ATTEMPTS} attempts: ${reason}`,
        );
      }
      // Never reached the chain, so retrying is free. The delay is for the
      // lagging node to catch up, not for anything on-chain to settle.
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
  const current = await allowanceOf(wallet.address);
  if (current >= needed) {
    console.log(`  · ${label}: allowance already ${usdc(current)}, no approval needed`);
    return;
  }
  // Approve the exact amount rather than an unlimited allowance. On a
  // prototype whose escrow is immutable and unaudited, an infinite approval is
  // a standing risk with no upside.
  await send(wallet, USDC, erc20Abi, 'approve', [ESCROW, needed]);
  console.log(`  · ${label}: approved ${usdc(needed)}`);
}

async function readPurchase(id: bigint) {
  return publicClient.readContract({
    address: ESCROW,
    abi: escrowWriteAbi,
    functionName: 'getPurchase',
    args: [id],
  });
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function inspect(id: bigint): Promise<void> {
  const p = await readPurchase(id);
  hr(`Purchase ${id}`);
  console.log(`  seller          ${p.seller}`);
  console.log(`  buyer           ${p.buyer}`);
  console.log(`  price           ${usdc(p.price)}`);
  console.log(`  stage           ${STAGE[p.stage] ?? p.stage}`);
  console.log(`  criteria        ${p.criteriaCount}`);
  console.log(`  disputeBond     ${usdc(p.disputeBond)}`);
  console.log(`  disputedBitmap  0b${p.disputedBitmap.toString(2).padStart(p.criteriaCount, '0')}`);
  console.log(`  deliveredAt     ${p.deliveredAt === 0n ? '(not delivered)' : p.deliveredAt}`);

  if (STAGE[p.stage] === 'DISPUTED') {
    const [key, promise, rubric, evidence] = await Promise.all([
      publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'genlayerKey', args: [id] }),
      publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'promiseHash', args: [id] }),
      publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'rubricHash', args: [id] }),
      publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'evidenceRoot', args: [id] }),
    ]);
    console.log(`\n  ── what the relayer must reproduce ──`);
    console.log(`  genlayerKey     ${key}`);
    console.log(`  promiseHash     ${promise}`);
    console.log(`  rubricHash      ${rubric}`);
    console.log(`  evidenceRoot    ${evidence}`);
  }
}

async function preflight(): Promise<void> {
  hr('Preflight');
  const [count, held, relayer] = await Promise.all([
    publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'purchaseCount' }),
    publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'totalHeld' }),
    publicClient.readContract({ address: ESCROW, abi: parseAbi(['function relayer() view returns (address)']), functionName: 'relayer' }),
  ]);
  const escrowUsdc = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ESCROW],
  });
  console.log(`  escrow          ${ESCROW}`);
  console.log(`  purchases       ${count}`);
  console.log(`  relayer         ${relayer}`);
  console.log(`  totalHeld()     ${usdc(held)}`);
  console.log(`  USDC at escrow  ${usdc(escrowUsdc)}`);
  if (held !== escrowUsdc) {
    throw new Error(
      `RECONCILIATION FAILURE: totalHeld() is ${usdc(held)} but the escrow holds ` +
        `${usdc(escrowUsdc)}. Retained value, or a token with a fee-on-transfer. ` +
        `Stop and investigate before running the demo.`,
    );
  }
  console.log(`  ✓ totalHeld() reconciles with the escrow's USDC balance`);
}

/**
 * The highest-numbered purchase, or 0 if none exists.
 *
 * `nextPurchaseId` starts at 1 and `purchaseCount()` returns `nextPurchaseId - 1`,
 * so id 0 is a permanently-empty slot and `getPurchase(0)` returns a zeroed
 * struct rather than reverting. Reading the count as an id — which an earlier
 * version of this file did — points at that empty slot and fails with "not open"
 * on a purchase that was created perfectly well one step earlier.
 */
async function latestPurchaseId(): Promise<bigint> {
  return publicClient.readContract({
    address: ESCROW,
    abi: escrowWriteAbi,
    functionName: 'purchaseCount',
  });
}

async function stageOf(id: bigint): Promise<string> {
  const p = await readPurchase(id);
  return STAGE[p.stage] ?? String(p.stage);
}

/**
 * Poll until a read reflects the state a transaction just produced.
 *
 * The same lagging-node problem that makes an ESTIMATE revert also makes a READ
 * stale: `getPurchase()` is answered by whichever node the RPC's load balancer
 * picks, and one of them can be seconds behind the block our transaction landed
 * in. Observed live — `openDispute` was mined, the escrow's USDC balance rose to
 * 5.25, and a `getPurchase` a moment later still reported `DELIVERED` with a
 * zero bond. The contract was right; the reader was behind.
 *
 * Waiting for more confirmations would not fix this, because the node can be
 * behind regardless of how many blocks we have. Polling until the value is what
 * the transaction produced is what actually converges — and it fails loudly
 * rather than printing a stale answer that reads like a contract bug.
 *
 * This matters beyond this script: the frontend reads the same way, so a user
 * who disputes and immediately opens the case page can be shown the state from
 * before their own transaction.
 */
async function waitForStage(id: bigint, expected: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  for (;;) {
    seen = await stageOf(id);
    if (seen === expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `purchase ${id} is still ${seen} after ${timeoutMs}ms; expected ${expected}. ` +
          `The transaction WAS mined — re-run with --inspect ${id} in a moment to ` +
          `confirm. This is the public RPC lagging, not the contract.`,
      );
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

// --- steps -----------------------------------------------------------------

async function createOffer(seller: Wallet): Promise<bigint> {
  hr('1. createOffer  (seller)');
  const price = 5_000_000n; // 5 USDC
  const now = BigInt(Math.floor(Date.now() / 1000));
  const deliveryDeadline = now + 7n * 24n * 60n * 60n;
  const reviewWindow = 3600n; // the minimum the contract allows

  const promiseText =
    'I will deliver a written technical review of the Recourse escrow contract, ' +
    'covering the settlement path and the access-control surface, with a findings ' +
    'table and a reproduction note for each finding.';

  const rubric = [
    'The review names every finding it reports and gives each one a severity rating.',
    'Every finding includes a concrete reproduction step or a specific code reference.',
    'The review is delivered as a single PDF document.',
  ];
  console.log(`  price           ${usdc(price)}`);
  console.log(`  reviewWindow    ${reviewWindow}s`);
  console.log(`  rubric items    ${rubric.length}`);

  const id = (await latestPurchaseId()) + 1n;
  await send(seller, ESCROW, escrowWriteAbi, 'createOffer', [
    price,
    deliveryDeadline,
    reviewWindow,
    promiseText,
    rubric,
  ]);
  console.log(`  → purchaseId    ${id}`);
  return id;
}

async function purchase(buyer: Wallet, id: bigint): Promise<void> {
  hr('2. purchase  (buyer)');
  const p = await readPurchase(id);
  console.log(`  price           ${usdc(p.price)}`);
  await approveIfNeeded(buyer, p.price, 'price');
  await send(buyer, ESCROW, escrowWriteAbi, 'purchase', [id]);
}

async function deliver(seller: Wallet, id: bigint): Promise<void> {
  hr('3. submitDelivery  (seller)');
  await send(seller, ESCROW, escrowWriteAbi, 'submitDelivery', [
    id,
    'Delivered recourse-review.pdf (7 pages, 4 findings: 1 high, 2 medium, 1 low). ' +
      'The reproduction notes are inline under each finding.',
  ]);
}

async function dispute(buyer: Wallet, id: bigint): Promise<void> {
  hr('4. openDispute  (buyer)');
  const p = await readPurchase(id);
  const bond = await publicClient.readContract({
    address: ESCROW,
    abi: escrowWriteAbi,
    functionName: 'disputeBond',
    args: [p.price],
  });
  console.log(`  bond            ${usdc(bond)}`);
  await approveIfNeeded(buyer, bond, 'bond');
  // Criterion index 2 (the third) is the one disputed — "delivered as a single
  // PDF". Bit 2 set => 0b100. The order matters: it is the same order as the
  // rubric array above, and the same order the verdict's bitmap will use.
  await send(buyer, ESCROW, escrowWriteAbi, 'openDispute', [
    id,
    0b100,
    'No PDF was attached to the delivery. The notes describe a PDF but the ' +
      'deliverable itself was never provided in that format.',
  ]);
}

// --- the run ---------------------------------------------------------------

async function run(): Promise<void> {
  const seller = loadWallet('deployer');
  const buyer = loadWallet('demo');

  await preflight();

  hr('Wallets');
  for (const w of [seller, buyer]) {
    const [eth, usdcBal] = await Promise.all([
      publicClient.getBalance({ address: w.address }),
      publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [w.address] }),
    ]);
    console.log(`  ${w.name.padEnd(10)} ${w.address}  ${formatUnits(eth, 18)} ETH  ${usdc(usdcBal)}`);
    if (eth === 0n) throw new Error(`${w.name} has no ETH for gas`);
  }

  // State-driven, not script-driven. Every step below is a real transaction
  // that costs gas and can be interrupted by a timeout, a dropped RPC or a
  // Ctrl-C — so on each run we read where the chain actually is and advance
  // from there. Re-running after a failure resumes instead of creating another
  // offer, and running it twice in a row is a no-op rather than a duplicate.
  let id = await latestPurchaseId();
  let stage = id === 0n ? 'NONE' : await stageOf(id);
  console.log(`\n  resuming at purchase ${id}, stage ${stage}`);

  if (id === 0n || stage === 'SETTLED' || stage === 'NONE') {
    id = await createOffer(seller);
    stage = 'OPEN';
  }

  if (stage === 'OPEN') {
    await purchase(buyer, id);
    stage = 'FUNDED';
  }
  if (stage === 'FUNDED') {
    await deliver(seller, id);
    stage = 'DELIVERED';
  }
  if (stage === 'DELIVERED') {
    await dispute(buyer, id);
    stage = 'DISPUTED';
  }

  // The reads below must not race the transaction above.
  await waitForStage(id, 'DISPUTED');

  await inspect(id);

  ownReconciliationCheck(await readPurchase(id));
  console.log(`\n  Next: cd relayer && DRY_RUN=true node --env-file=.env dist/index.js`);
}

/**
 * `totalHeld()` must equal the escrow's actual USDC balance — at rest and,
 * more importantly, mid-dispute, when it holds both a price and a bond.
 *
 * This is the one check nothing else in the project performs. Foundry cannot
 * see the token's real balance semantics, and the relayer only ever reads the
 * contract's own accounting — so a retained-value bug, or a token that takes a
 * fee on transfer, would be invisible to both and would show up here as a
 * divergence between two numbers that must never diverge.
 */
async function ownReconciliationCheck(p: { price: bigint; disputeBond: bigint }): Promise<void> {
  const [held, escrowUsdc] = await Promise.all([
    publicClient.readContract({ address: ESCROW, abi: escrowWriteAbi, functionName: 'totalHeld' }),
    publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [ESCROW] }),
  ]);
  hr('Mid-dispute reconciliation');
  console.log(`  expected        ${usdc(p.price + p.disputeBond)} (price + bond)`);
  console.log(`  totalHeld()     ${usdc(held)}`);
  console.log(`  USDC at escrow  ${usdc(escrowUsdc)}`);
  if (held !== escrowUsdc) {
    throw new Error(
      `RECONCILIATION FAILURE: totalHeld() is ${usdc(held)} but the escrow holds ` +
        `${usdc(escrowUsdc)}. That divergence means retained value or a ` +
        `fee-on-transfer token. Stop — do not demo this.`,
    );
  }
  if (held !== p.price + p.disputeBond) {
    throw new Error(
      `ACCOUNTING FAILURE: the escrow holds ${usdc(held)} but this purchase ` +
        `committed ${usdc(p.price + p.disputeBond)}. They agree with each other ` +
        `and disagree with the case — find out why.`,
    );
  }
  console.log(`  ✓ holds exactly price + bond, and both independent reads agree`);
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const inspectIdx = args.indexOf('--inspect');
if (inspectIdx !== -1) {
  await inspect(BigInt(args[inspectIdx + 1] ?? '0'));
} else {
  await run();
}
