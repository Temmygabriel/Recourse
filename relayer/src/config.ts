/**
 * Environment parsing, validated once at startup.
 *
 * Every value is checked here rather than at the point of use, so a
 * misconfiguration is a single clear error at boot instead of a confusing
 * failure twenty minutes into a demo. Nothing in this file ever echoes a
 * secret: `describeConfig` prints an allowlist of fields, never the key.
 */

import { readFileSync } from 'node:fs';
import { isAddress, getAddress, type Address } from 'viem';

import { isLevel, type Level } from './log.ts';

export interface Config {
  readonly baseRpcUrl: string;
  readonly escrow: Address;
  /** 32-byte hex. Only ever passed to the signer; never logged. */
  readonly relayerPrivateKey: `0x${string}`;
  /**
   * Which chain definition to hand to genlayer-js. Resolved to a real object
   * in `genlayer.ts`, because the exact export name is SDK-version-dependent
   * and a hard named import would be a build error we cannot see from the
   * development machine.
   */
  readonly genlayerChain: string;
  readonly genlayerChainIdOverride?: number;
  readonly genlayerContract: Address;
  readonly pollIntervalMs: number;
  readonly stateFile: string;
  /** Sign and simulate, but never broadcast. */
  readonly dryRun: boolean;
  readonly logLevel: Level;
  /** Upper bound on purchases examined per tick. */
  readonly maxPurchasesPerTick: number;
}

class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError(
      `${key} is required. See relayer/.env.example — the process refuses to ` +
        `start with a partial configuration rather than fail later mid-settlement.`,
    );
  }
  return raw.trim();
}

function optionalInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return n;
}

function optionalBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${key} must be a boolean-ish value, got "${raw}"`);
}

function requireAddress(env: NodeJS.ProcessEnv, key: string): Address {
  const raw = required(env, key);
  if (!isAddress(raw)) {
    throw new ConfigError(`${key} is not a valid address: "${raw}"`);
  }
  return getAddress(raw);
}

/**
 * The relayer's signing key: either inline or, preferably, read from a file.
 *
 * The file form exists because the key lives in `.secrets/` on the developer's
 * machine (gitignored). Reading it there keeps it out of shell history, out of
 * the process environment — where any child process and any crash dump can see
 * it — and out of `docker inspect`. Prefer it.
 */
function loadPrivateKey(env: NodeJS.ProcessEnv): `0x${string}` {
  const inline = env['RELAYER_PRIVATE_KEY'];
  const file = env['RELAYER_PRIVATE_KEY_FILE'];

  let raw: string;
  if (inline !== undefined && inline.trim() !== '') {
    raw = inline.trim();
  } else if (file !== undefined && file.trim() !== '') {
    try {
      raw = readFileSync(file.trim(), 'utf8').trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ConfigError(`RELAYER_PRIVATE_KEY_FILE could not be read: ${msg}`);
    }
  } else {
    throw new ConfigError(
      'Set RELAYER_PRIVATE_KEY_FILE (preferred — point it at the file in ' +
        '.secrets/) or RELAYER_PRIVATE_KEY. The relayer cannot sign without one.',
    );
  }

  // Accept the several shapes a key is written in by hand or by our own
  // generator, so a trailing newline or a "0x" prefix is never the reason a
  // demo fails.
  const cleaned = raw.replace(/[\s'"]/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new ConfigError(
      'The relayer private key must be 32 bytes of hex (64 hex characters, ' +
        'with or without a 0x prefix). Refusing to start with an ambiguous key.',
    );
  }
  return `0x${cleaned.toLowerCase()}` as `0x${string}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    const levelRaw = (env['LOG_LEVEL'] ?? 'info').trim().toLowerCase();
    if (!isLevel(levelRaw)) {
      throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error; got "${levelRaw}"`);
    }

    const chainIdRaw = env['GENLAYER_CHAIN_ID'];
    const chainIdOverride =
      chainIdRaw === undefined || chainIdRaw.trim() === ''
        ? undefined
        : optionalInt(env, 'GENLAYER_CHAIN_ID', 0, 1, Number.MAX_SAFE_INTEGER);

    const base: Config = {
      baseRpcUrl: required(env, 'BASE_RPC_URL'),
      escrow: requireAddress(env, 'ESCROW_ADDRESS'),
      relayerPrivateKey: loadPrivateKey(env),
      // The canonical export name of genlayer-js 2.0.0-rc.1. The v0.6 migration
      // doc calls it "studio-dev", which still resolves via CHAIN_ALIASES, but
      // the default should be the name the package actually exports.
      genlayerChain: (env['GENLAYER_CHAIN'] ?? 'studioDevnet').trim(),
      genlayerContract: requireAddress(env, 'GENLAYER_CONTRACT_ADDRESS'),
      pollIntervalMs: optionalInt(env, 'POLL_INTERVAL_MS', 15_000, 1_000, 3_600_000),
      stateFile: (env['STATE_FILE'] ?? './.relayer-state.json').trim(),
      dryRun: optionalBool(env, 'DRY_RUN', false),
      logLevel: levelRaw,
      maxPurchasesPerTick: optionalInt(env, 'MAX_PURCHASES_PER_TICK', 50, 1, 5_000),
    };
    return chainIdOverride === undefined ? base : { ...base, genlayerChainIdOverride: chainIdOverride };
  } catch (e) {
    if (e instanceof ConfigError) {
      throw new Error(`relayer configuration: ${e.message}`);
    }
    throw e;
  }
}

/** Safe to log. Deliberately an allowlist, not a spread with deletions. */
export function describeConfig(c: Config): Record<string, unknown> {
  return {
    baseRpcUrl: c.baseRpcUrl.replace(/\/\/[^@/]+@/, '//<redacted>@'),
    escrow: c.escrow,
    genlayerChain: c.genlayerChain,
    genlayerChainIdOverride: c.genlayerChainIdOverride ?? null,
    genlayerContract: c.genlayerContract,
    pollIntervalMs: c.pollIntervalMs,
    stateFile: c.stateFile,
    dryRun: c.dryRun,
    logLevel: c.logLevel,
    maxPurchasesPerTick: c.maxPurchasesPerTick,
    relayerPrivateKey: '<set>',
  };
}
