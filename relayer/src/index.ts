/**
 * Recourse relayer — GenLayer verdict to Base settlement.
 *
 * WHAT IT IS, AND WHAT IT IS NOT.
 *
 * It transports. It reads a dispute from Base, asks the GenLayer judgment
 * contract to rule on it, and delivers the ruling back to Base as a signed
 * `SettlementDecision` for the escrow to verify. It does not decide anything:
 * the verdict is authored by GenLayer's validator set, and every field the
 * relayer carries is re-checked against the escrow's own storage on arrival.
 *
 * The one thing the relayer asserts and Base cannot check is
 * `SettlementDecision.finalized` — an EVM contract cannot read GenLayer
 * consensus state. This process sets it only after observing status
 * ACCEPTED/FINALIZED *and* execution result FINISHED_WITH_RETURN, and the
 * escrow trusts that assertion. This is the documented trust boundary; the
 * README does not describe the system as trustless, and neither should this
 * file's comments.
 *
 * FLOW, once per disputed purchase:
 *
 *   1. read the purchase and dispute from Base
 *   2. verify every commitment the relayer computes against the escrow's own
 *      view functions                     <- before spending a fee
 *   3. GenLayer: evaluate(key, package)   <- the only costly step
 *   4. wait for finality, then read the stored verdict back
 *   5. re-validate the verdict and check the escrow will accept it
 *   6. sign the decision; verify the signature recovers, then simulate settle()
 *   7. broadcast settle()
 *
 * Every step is resumable (see store.ts). Steps 2, 5 and 6 exist so that a
 * failure lands before anything moves, or does not land at all.
 */

import {
  concatHex,
  encodeAbiParameters,
  formatEther,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

import { escrowAbi, OUTCOME, STAGE } from './abi.ts';
import { describeConfig, loadConfig, type Config } from './config.ts';
import {
  buildDecision,
  domain,
  parseVerdict,
  SETTLEMENT_TYPES,
  typedDataMessage,
  type SettlementDecision,
} from './decision.ts';
import {
  chainCommitments,
  chainHashDecision,
  createBaseContext,
  genlayerKey,
  getPurchase,
  localCommitments,
  preflight,
  sendSettle,
  simulateSettle,
  verifyCommitments,
  type BaseContext,
} from './escrow.ts';
import { createSdk, describeSdk, evaluate, readDecision, waitForFinality, type Sdk } from './genlayer.ts';
import { decisionDigestHex } from './hashes.ts';
import { errText, log, revertReason, setLevel } from './log.ts';
import { buildPackage, serializePackage } from './package.ts';
import { logResume, Store, type PurchaseState } from './store.ts';

const OUTCOME_NAME: Record<number, string> = {
  [OUTCOME.RELEASE]: 'RELEASE',
  [OUTCOME.PARTIAL_REFUND]: 'PARTIAL_REFUND',
  [OUTCOME.FULL_REFUND]: 'FULL_REFUND',
  [OUTCOME.UNDETERMINED]: 'UNDETERMINED',
};

function outcomeName(outcome: number): string {
  return OUTCOME_NAME[outcome] ?? `unknown(${outcome})`;
}

interface Runtime {
  config: Config;
  ctx: BaseContext;
  sdk: Sdk;
  store: Store;
  sourceChainId: bigint;
  sourceContract: Address;
  purchaseCount: number;
}

let stopping = false;

function requestStop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log.info(`received ${signal}; finishing the current purchase and exiting`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setLevel(config.logLevel);

  log.info('recourse relayer starting', describeConfig(config));

  const ctx = createBaseContext(config.baseRpcUrl, config.escrow, config.relayerPrivateKey);
  log.info('relayer address', { address: ctx.account.address });

  // Fail fast on the two configuration errors that would otherwise surface as
  // an opaque revert at the end of a fee-spending pipeline.
  const { sourceChainId, sourceContract, purchaseCount } = await preflight(ctx);
  log.info('escrow verified', {
    escrow: config.escrow,
    purchaseCount,
    sourceChainId: sourceChainId.toString(),
    sourceContract,
  });

  const sdk = await createSdk({
    chainName: config.genlayerChain,
    account: ctx.account,
    ...(config.genlayerChainIdOverride === undefined
      ? {}
      : { chainIdOverride: config.genlayerChainIdOverride }),
  });
  log.debug('genlayer sdk surface', describeSdk(sdk));

  // The escrow accepts verdicts from exactly one GenLayer chain. If the
  // configured chain is a different one, `settle()` reverts with "wrong source
  // chain" after the evaluation fee is already spent — so catch it now, by
  // chain id, which is the value the contract actually compares.
  assertChainMatchesEscrow(sdk, sourceChainId);

  const store = new Store(config.stateFile);
  logResume(store);

  if (!config.dryRun) await warnIfLowGas(ctx);

  const runtime: Runtime = {
    config,
    ctx,
    sdk,
    store,
    sourceChainId,
    sourceContract,
    purchaseCount,
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => requestStop(sig));
  }

  const onceOnly = config.dryRun || process.argv.includes('--once');

  do {
    try {
      await tick(runtime);
    } catch (e) {
      // A throwing tick is a transient problem (RPC down, node restarting) and
      // must not kill the process: the next tick tries again, and the store
      // still holds everyone's place.
      log.error('tick failed', { error: errText(e) });
    }
    if (stopping || onceOnly) break;
    await sleep(config.pollIntervalMs);
  } while (!stopping);

  log.info('relayer stopped', { summary: store.summary() });
}

/**
 * Compare the resolved chain definition's id to the escrow's `sourceChainId`.
 *
 * The chain object comes from the SDK and carries its own id; the escrow's is
 * immutable and was set at deploy. They must be the same number or no verdict
 * this relayer ever produces can be settled.
 */
function assertChainMatchesEscrow(sdk: Sdk, sourceChainId: bigint): void {
  const raw = sdk.client as unknown as Record<string, unknown>;
  const chain = raw['chain'];
  const chainId =
    typeof chain === 'object' && chain !== null
      ? (chain as Record<string, unknown>)['id']
      : undefined;

  if (typeof chainId !== 'number') {
    log.warn(
      'could not read the resolved chain id off the client to compare against the escrow',
      { expectedSourceChainId: sourceChainId.toString() },
    );
    return;
  }
  if (BigInt(chainId) !== sourceChainId) {
    throw new Error(
      `the configured GenLayer chain resolves to id ${chainId}, but the escrow's immutable ` +
        `sourceChainId is ${sourceChainId}. Every settlement would revert with "wrong source ` +
        `chain" after the evaluation fee was spent. Point GENLAYER_CHAIN at the chain the ` +
        `escrow was deployed for, or redeploy the escrow against this one.`,
    );
  }
  log.info('genlayer chain matches the escrow', { chainId });
}

async function warnIfLowGas(ctx: BaseContext): Promise<void> {
  try {
    const balance = await ctx.publicClient.getBalance({ address: ctx.account.address });
    const line = { address: ctx.account.address, balanceEth: formatEther(balance) };
    if (Number(formatEther(balance)) < 0.0005) {
      log.warn(
        'relayer ETH balance is low; settle() will start failing once it runs out. ' +
          'Fund this address from a Base Sepolia faucet.',
        line,
      );
    } else {
      log.info('relayer gas balance', line);
    }
  } catch (e) {
    log.warn('could not read the relayer gas balance', { error: errText(e) });
  }
}

async function tick(rt: Runtime): Promise<void> {
  // Refresh the count each tick: offers and purchases arrive while we run.
  const count = Number(
    await rt.ctx.publicClient.readContract({
      address: rt.ctx.escrow,
      abi: escrowAbi,
      functionName: 'purchaseCount',
    }),
  );
  rt.purchaseCount = count;
  if (count === 0) return;

  const scanned = Math.min(count, rt.config.maxPurchasesPerTick);
  if (count > scanned) {
    log.warn('purchase count exceeds MAX_PURCHASES_PER_TICK; not everything was scanned', {
      purchaseCount: count,
      scanned,
    });
  }

  // Purchases already settled are skipped without a read. The store is the only
  // thing that knows, and re-reading every settled purchase forever would make
  // polling cost grow without bound.
  const toRead: number[] = [];
  for (let id = 1; id <= scanned; id++) {
    const s = rt.store.get(id);
    if (s?.status === 'settled' || s?.status === 'failed') continue;
    toRead.push(id);
  }
  if (toRead.length === 0) return;

  const purchases = await Promise.all(
    toRead.map(async (id) => ({ id, purchase: await getPurchase(rt.ctx, id) })),
  );

  for (const { id, purchase } of purchases) {
    if (stopping) return;
    if (purchase.stage !== STAGE.DISPUTED) continue;
    await handleDispute(rt, id);
  }
}

async function handleDispute(rt: Runtime, id: number): Promise<void> {
  const { ctx, sdk, store, config } = rt;
  const state = store.get(id);

  // Resuming a run that already submitted an evaluation: wait on that
  // transaction rather than paying for a second one.
  if (state?.status === 'evaluating' && state.genlayerTxHash !== undefined) {
    log.info('resuming an evaluation already submitted to genlayer', {
      purchaseId: id,
      genlayerTxHash: state.genlayerTxHash,
    });
    return finishEvaluation(rt, id, state.genlayerTxHash as Hex);
  }
  if (state?.status === 'evaluated') {
    log.info('verdict already obtained; resuming at settlement', { purchaseId: id });
    return settleWith(rt, id, state);
  }

  const purchase = await getPurchase(ctx, id);
  if (purchase.stage !== STAGE.DISPUTED) return;

  // --- step 2: prove our hashing agrees with Solidity, before spending ------
  const local = localCommitments(purchase);
  const chain = await chainCommitments(ctx, id);
  verifyCommitments(id, local, chain);
  log.info('commitments verified against the escrow', {
    purchaseId: id,
    promiseHash: chain.promiseHash,
    evidenceRoot: chain.evidenceRoot,
  });

  const key = await genlayerKey(ctx, id);
  const pkg = buildPackage(purchase, local);
  const packageJson = serializePackage(pkg);
  log.info('submitting evidence package to genlayer', {
    purchaseId: id,
    genlayerKey: key,
    criteriaCount: purchase.criteriaCount,
    disputedIndices: pkg.disputed_indices.join(','),
  });

  // --- step 3: the only step that costs a fee ------------------------------
  let txHash: Hex;
  try {
    txHash = await evaluate({
      sdk,
      contract: config.genlayerContract,
      purchaseKey: key,
      packageJson,
    });
  } catch (e) {
    await store.update(id, { genlayerKey: key });
    await store.recordError(id, `evaluate() submission failed: ${errText(e)}`, false);
    log.error('genlayer evaluation could not be submitted; will retry', {
      purchaseId: id,
      error: errText(e),
    });
    return;
  }

  // Written before the wait, so a crash during finality resumes here rather
  // than submitting (and paying for) a second evaluation.
  await store.update(id, {
    status: 'evaluating',
    genlayerKey: key,
    genlayerTxHash: txHash,
    lastError: undefined,
  });
  log.info('evaluation submitted', { purchaseId: id, genlayerTxHash: txHash });

  await finishEvaluation(rt, id, txHash);
}

async function finishEvaluation(rt: Runtime, id: number, txHash: Hex): Promise<void> {
  const { sdk, store, config } = rt;

  let finalized;
  try {
    finalized = await waitForFinality(sdk, txHash);
  } catch (e) {
    await store.recordError(id, `waiting for finality failed: ${errText(e)}`, false);
    log.error('could not confirm genlayer finality; will retry next tick', {
      purchaseId: id,
      genlayerTxHash: txHash,
      error: errText(e),
    });
    return;
  }

  if (!finalized.ok) {
    // Deliberately terminal. Retrying a round whose validators disagreed just
    // re-rolls the same dice, and the supported remedy for a bad round is an
    // appeal — which costs a bond and is a human decision. So this stops and
    // says so, rather than looping quietly.
    const message =
      `genlayer evaluation did not succeed: status=${finalized.statusName || '?'} ` +
      `result=${finalized.executionResultName || '?'}`;
    await store.recordError(id, message, true);
    log.error(
      'genlayer evaluation failed; this purchase is marked failed and will not be retried. ' +
        'The supported remedy is an appeal, not a resubmission — see the Appeals section of ' +
        'relayer/README.md.',
      {
        purchaseId: id,
        genlayerTxHash: txHash,
        statusName: finalized.statusName,
        executionResultName: finalized.executionResultName,
        raw: JSON.stringify(finalized.raw).slice(0, 500),
      },
    );
    return;
  }

  const key = store.get(id)?.genlayerKey;
  if (key === undefined || key === '') {
    throw new Error(`purchase ${id} is in state "evaluating" with no genlayerKey recorded`);
  }

  // --- step 4: read the verdict that consensus actually stored -------------
  let rawVerdict: unknown;
  try {
    rawVerdict = await readDecision(sdk, config.genlayerContract, key);
  } catch (e) {
    await store.recordError(id, `reading the verdict failed: ${errText(e)}`, false);
    log.error('could not read the stored verdict; will retry', {
      purchaseId: id,
      genlayerKey: key,
      error: errText(e),
    });
    return;
  }

  const purchase = await getPurchase(rt.ctx, id);

  // --- step 5: validate, and confirm the escrow will accept it -------------
  const parsed = parseVerdict(rawVerdict, purchase.criteriaCount);
  const digest = decisionDigestHex(parsed.canonicalJson);
  const commitments = await chainCommitments(rt.ctx, id);

  // Building the decision runs the coherence check, so a verdict the escrow
  // would reject is caught here instead of as a reverted broadcast.
  buildDecision({
    purchaseId: id,
    genlayerTxHash: txHash,
    sourceChainId: rt.sourceChainId,
    sourceContract: rt.sourceContract,
    promiseHash: commitments.promiseHash,
    rubricHash: commitments.rubricHash,
    evidenceRoot: commitments.evidenceRoot,
    decisionDigest: digest,
    verdict: parsed.verdict,
    criteriaCount: purchase.criteriaCount,
    finalized: true,
  });

  await store.update(id, {
    status: 'evaluated',
    verdictJson: parsed.canonicalJson,
    decisionDigest: digest,
    lastError: undefined,
  });
  log.info('verdict obtained', {
    purchaseId: id,
    outcome: outcomeName(parsed.verdict.outcome),
    refundBps: parsed.verdict.refundBps,
    criteriaMet: parsed.verdict.criteriaMet.map((m) => (m ? 1 : 0)).join(''),
    reason: parsed.verdict.reason.slice(0, 200),
    decisionDigest: digest,
  });

  const refreshed = store.get(id);
  if (refreshed === undefined) throw new Error(`state for purchase ${id} vanished`);
  await settleWith(rt, id, refreshed);
}

async function settleWith(rt: Runtime, id: number, state: PurchaseState): Promise<void> {
  const { ctx, config, store } = rt;
  if (state.verdictJson === undefined) {
    throw new Error(`purchase ${id} has no stored verdict to settle`);
  }
  if (state.genlayerTxHash === undefined) {
    throw new Error(`purchase ${id} has no genlayerTxHash, so no nonce can be derived`);
  }

  const purchase = await getPurchase(ctx, id);
  if (purchase.stage !== STAGE.DISPUTED) {
    // Something else happened to it in the meantime. Nothing to do.
    log.warn('purchase is no longer disputed; skipping settlement', {
      purchaseId: id,
      stage: purchase.stage,
    });
    return;
  }

  const parsed = parseVerdict(state.verdictJson, purchase.criteriaCount);
  const digest = (state.decisionDigest ?? decisionDigestHex(state.verdictJson)) as Hex;
  const commitments = await chainCommitments(ctx, id);
  const decision = buildDecision({
    purchaseId: id,
    genlayerTxHash: state.genlayerTxHash as Hex,
    sourceChainId: rt.sourceChainId,
    sourceContract: rt.sourceContract,
    promiseHash: commitments.promiseHash,
    rubricHash: commitments.rubricHash,
    evidenceRoot: commitments.evidenceRoot,
    decisionDigest: digest,
    verdict: parsed.verdict,
    criteriaCount: purchase.criteriaCount,
    finalized: true,
  });

  // --- step 6: sign, then prove the signature is the one the escrow wants ---
  const signature = await ctx.walletClient.signTypedData({
    account: ctx.account,
    domain: domain(chainIdOf(ctx), ctx.escrow),
    types: SETTLEMENT_TYPES,
    primaryType: 'SettlementDecision',
    message: typedDataMessage(decision),
  });

  await assertSignatureRecovers(rt, decision, signature);
  await compareWithChainHash(rt, decision);

  const simulation = await simulateSettle(ctx, decision, signature);
  if (!simulation.ok) {
    const reason = revertReason(simulation.reason);
    log.error(
      "settle() would revert, so nothing was broadcast. The reason is the contract's own, so " +
        'it names the check that failed — see the rejection list on settle() in ' +
        'contracts/src/RecourseEscrow.sol.',
      { purchaseId: id, nonce: decision.nonce.toString(), reason },
    );
    await store.recordError(id, `settle() simulation reverted: ${reason}`, false);
    return;
  }

  if (config.dryRun) {
    log.info('DRY_RUN: decision signed and simulated successfully; not broadcasting', {
      purchaseId: id,
      nonce: decision.nonce.toString(),
      outcome: outcomeName(decision.outcome),
      refundBps: decision.refundBps,
      criteriaMetBitmap: decision.criteriaMetBitmap,
    });
    await store.update(id, { nonce: decision.nonce.toString() });
    return;
  }

  // --- step 7: broadcast ---------------------------------------------------
  let baseTxHash: Hex;
  try {
    baseTxHash = await sendSettle(ctx, decision, signature);
  } catch (e) {
    const reason = revertReason(e);
    await store.recordError(id, `settle() broadcast failed: ${reason}`, false);
    log.error('settle() broadcast failed; will retry with the same nonce', {
      purchaseId: id,
      nonce: decision.nonce.toString(),
      reason,
    });
    return;
  }

  await store.update(id, { nonce: decision.nonce.toString(), baseTxHash });
  log.info('settlement broadcast', {
    purchaseId: id,
    baseTxHash,
    nonce: decision.nonce.toString(),
  });

  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: baseTxHash });
  if (receipt.status !== 'success') {
    await store.recordError(id, `settlement transaction ${baseTxHash} reverted`, false);
    log.error('settlement transaction reverted on chain', { purchaseId: id, baseTxHash });
    return;
  }

  await store.update(id, { status: 'settled', lastError: undefined });
  log.info('SETTLED', {
    purchaseId: id,
    outcome: outcomeName(decision.outcome),
    refundBps: decision.refundBps,
    nonce: decision.nonce.toString(),
    baseTxHash,
    genlayerTxHash: decision.genlayerTxHash,
    decisionDigest: decision.decisionDigest,
  });
}

/**
 * Check the signature recovers to our own address before it goes anywhere.
 *
 * viem signs and recovers with the same code, so this mostly proves the message
 * we signed is the one we think we signed — worth having, because the failure
 * it catches (a field silently dropped or widened between `buildDecision` and
 * `signTypedData`) is invisible in the broadcast and only shows up on chain as
 * "bad relayer signature", after the GenLayer fee has been spent.
 */
async function assertSignatureRecovers(
  rt: Runtime,
  decision: SettlementDecision,
  signature: Hex,
): Promise<void> {
  const recovered = await recoverTypedDataAddress({
    domain: domain(chainIdOf(rt.ctx), rt.ctx.escrow),
    types: SETTLEMENT_TYPES,
    primaryType: 'SettlementDecision',
    message: typedDataMessage(decision),
    signature,
  });
  if (recovered.toLowerCase() !== rt.ctx.account.address.toLowerCase()) {
    throw new Error(
      `the signature we produced recovers to ${recovered}, not ${rt.ctx.account.address}. ` +
        `Refusing to broadcast a settlement the escrow would reject.`,
    );
  }
}

// ---------------------------------------------------------------------------
// A hand-written transcription of the escrow's EIP-712 hashing.
//
// Deliberately independent of viem's `signTypedData`/`hashTypedData`: the point
// of comparing this to the chain is that it is a separate implementation. If it
// agreed because both went through the same helper, the comparison would prove
// nothing about whether Solidity and viem agree.
// ---------------------------------------------------------------------------

const DOMAIN_TYPEHASH = keccak256(
  stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

const SETTLEMENT_TYPEHASH = keccak256(
  stringToHex(
    'SettlementDecision(uint256 purchaseId,uint256 nonce,uint256 sourceChainId,address sourceContract,bytes32 genlayerTxHash,bytes32 promiseHash,bytes32 rubricHash,bytes32 evidenceRoot,bytes32 decisionDigest,uint8 outcome,uint16 refundBps,uint8 criteriaMetBitmap,bool finalized)',
  ),
);

function hashDecisionLocally(rt: Runtime, d: SettlementDecision): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint16' },
        { type: 'uint8' },
        { type: 'bool' },
      ],
      [
        SETTLEMENT_TYPEHASH,
        d.purchaseId,
        d.nonce,
        d.sourceChainId,
        d.sourceContract,
        d.genlayerTxHash,
        d.promiseHash,
        d.rubricHash,
        d.evidenceRoot,
        d.decisionDigest,
        d.outcome,
        d.refundBps,
        d.criteriaMetBitmap,
        d.finalized,
      ],
    ),
  );

  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        DOMAIN_TYPEHASH,
        keccak256(stringToHex('Recourse')),
        keccak256(stringToHex('1')),
        BigInt(chainIdOf(rt.ctx)),
        rt.ctx.escrow,
      ],
    ),
  );

  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

/**
 * Compare the relayer's EIP-712 hashing with the escrow's — and log, but do not
 * block, on a mismatch.
 *
 * That distinction is deliberate. If the two disagree, one of them is wrong and
 * this process cannot tell which; a false mismatch (a bug in the transcription
 * above) would otherwise block a relayer that works perfectly. The
 * authoritative check is `simulateSettle`, which runs the escrow's own
 * `_recover` against the exact arguments and signature we would send. So a
 * mismatch here is worth a loud warning and a very short bug hunt, and the
 * broadcast decision is left to the simulation.
 */
async function compareWithChainHash(rt: Runtime, decision: SettlementDecision): Promise<void> {
  try {
    const onChain = await chainHashDecision(rt.ctx, decision);
    const local = hashDecisionLocally(rt, decision);
    if (onChain.toLowerCase() === local.toLowerCase()) {
      log.debug('eip-712 struct hash agrees with the escrow', {
        purchaseId: decision.purchaseId.toString(),
      });
      return;
    }
    log.warn(
      "the relayer's local EIP-712 struct hash disagrees with the escrow's hashDecision(). " +
        'Either the transcription in index.ts is wrong, or the typehash in the contract ' +
        'changed. The settlement is still gated on simulateContract, so this warns about ' +
        "this process's own diagnostic rather than about the decision being signed.",
      { purchaseId: decision.purchaseId.toString(), onChain, local },
    );
  } catch (e) {
    log.debug('could not read hashDecision() for comparison', { error: errText(e) });
  }
}

function chainIdOf(ctx: BaseContext): number {
  const id = (ctx.publicClient.chain as { id?: number } | undefined)?.id;
  if (typeof id !== 'number') {
    throw new Error('the Base public client has no chain id; cannot build the EIP-712 domain');
  }
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e: unknown) => {
  log.error('relayer exited', { error: errText(e) });
  process.exitCode = 1;
});
