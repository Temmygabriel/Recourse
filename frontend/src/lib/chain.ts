/**
 * Chain access: one public client for reads, and a wallet client built from the
 * injected provider for writes.
 *
 * No wagmi, no RainbowKit (MEMORY.md D8). The whole wallet surface this app
 * needs is "ask for accounts, switch chain, send a transaction", and that is
 * about eighty lines of EIP-1193 — against two dependencies that each pull a
 * version-sensitive React tree into a build we cannot run locally. The demo
 * connects to one chain and does one thing at a time; a connector framework
 * would be load-bearing for none of it.
 *
 * Reads go through a plain HTTP client rather than the user's wallet, so a
 * visitor without a wallet can still read an offer, a case, or a verdict. Only
 * writes require one.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type PublicClient,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { escrowAbi } from './abi';

// --- Configuration ---------------------------------------------------------

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Copy frontend/.env.example to frontend/.env.local and fill it in. ` +
        `On Vercel, set it in Project Settings → Environment Variables.`,
    );
  }
  return value.trim();
}

export const CHAIN = baseSepolia;
export const CHAIN_ID = baseSepolia.id; // 84532

/**
 * The escrow address, resolved on first use rather than at module load.
 *
 * A missing `NEXT_PUBLIC_ESCROW_ADDRESS` must not fail the build. Next
 * prerenders every page on the server, so a throw at module scope would turn a
 * forgotten Vercel environment variable into a red deployment whose error
 * points at the build rather than at the setting. Resolving it lazily means the
 * build succeeds and the person who forgot it sees a message in the browser
 * that names the fix. (`NEXT_PUBLIC_*` values are still inlined at build time,
 * so a variable added after a deploy needs a redeploy to take effect — the
 * message says that too.)
 */
let cachedEscrow: Address | null = null;

export function escrowAddress(): Address {
  if (cachedEscrow === null) {
    cachedEscrow = requireEnv(
      'NEXT_PUBLIC_ESCROW_ADDRESS',
      process.env.NEXT_PUBLIC_ESCROW_ADDRESS,
    ) as Address;
  }
  return cachedEscrow;
}

/**
 * A public RPC endpoint. `https://sepolia.base.org` is rate-limited but has no
 * key and works from anywhere, which is what a submitted demo needs.
 */
export const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL?.trim() || 'https://sepolia.base.org';

export const EXPLORER_URL = 'https://sepolia.basescan.org';

/**
 * The escrow, as the `{ address, abi }` pair viem's `readContract` and
 * `writeContract` take. `address` is an accessor so that spreading this object
 * resolves the address at call time, not at import time.
 */
export const ESCROW = {
  get address(): Address {
    return escrowAddress();
  },
  abi: escrowAbi,
} as const;

// --- Clients ---------------------------------------------------------------

let cachedPublic: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (cachedPublic === null) {
    cachedPublic = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC_URL),
    }) as PublicClient;
  }
  return cachedPublic;
}

/**
 * The injected provider, or null when there is no wallet in this browser.
 *
 * Deliberately does not throw: every read-only screen has to keep working
 * without one, and the pages decide what to say.
 */
export function injected(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export class WalletError extends Error {}

/** Ask the wallet for an account, switching to Base Sepolia if it is elsewhere. */
export async function connect(): Promise<Address> {
  const provider = injected();
  if (provider === null) {
    throw new WalletError(
      'No wallet found in this browser. Install MetaMask (or any EVM wallet) and reload.',
    );
  }

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const first = accounts[0];
  if (first === undefined) {
    throw new WalletError('The wallet returned no accounts.');
  }

  await ensureChain(provider);
  return first as Address;
}

/** Currently-selected account, without prompting. Null if not connected. */
export async function currentAccount(): Promise<Address | null> {
  const provider = injected();
  if (provider === null) return null;
  try {
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[];
    return (accounts[0] as Address | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Move the wallet to Base Sepolia.
 *
 * `wallet_switchEthereumChain` fails with code 4902 when the wallet has never
 * seen the chain, so that case is caught and answered with an add-then-switch.
 * Without this, a user whose wallet defaults to Ethereum mainnet gets a
 * confusing "chain mismatch" on their first write and no way forward.
 */
async function ensureChain(provider: Eip1193Provider): Promise<void> {
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === CHAIN_ID) return;

  const hexId = `0x${CHAIN_ID.toString(16)}`;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902) {
      throw new WalletError(
        `Could not switch the wallet to ${baseSepolia.name}. ` +
          `Switch to it manually and try again.`,
      );
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: hexId,
          chainName: baseSepolia.name,
          nativeCurrency: baseSepolia.nativeCurrency,
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER_URL],
        },
      ],
    });
  }
}

/**
 * A wallet client bound to `account` on Base Sepolia.
 *
 * **The return type is deliberately inferred, not annotated `: WalletClient`.**
 * Do not "tidy" it back to the bare alias. The bare `WalletClient` defaults its
 * generics to `chain = Chain | undefined` and `account = Account | undefined`,
 * and viem's `IsUndefined<T> = [undefined] extends [T] ? true : false` evaluates
 * that union as TRUE. That flips `GetChainParameter` from its optional branch
 * (`{ chain?: ... }`) to its required one (`{ chain: ... }`), so every
 * `writeContract` on the result demands an explicit `chain` and fails to
 * typecheck with "Property 'chain' is missing" — which is exactly how this
 * broke the first Vercel build, reported against a call site in escrow.ts that
 * was itself correct.
 *
 * Letting TypeScript infer the return type keeps the concrete `typeof
 * baseSepolia` and `Address` in the signature, so `chain` and `account` are
 * already bound and the per-call parameters stay optional. A future caller
 * gets a client it can just use.
 */
export function walletClient(account: Address) {
  const provider = injected();
  if (provider === null) {
    throw new WalletError('No wallet found in this browser.');
  }
  return createWalletClient({
    account,
    chain: baseSepolia,
    transport: custom(provider),
  });
}

// --- USDC ------------------------------------------------------------------

export const USDC_DECIMALS = 6;

/**
 * The token address, read from the escrow rather than configured.
 *
 * The escrow knows which token it custodies and will not accept another, so
 * asking it removes a class of "the UI approved the wrong token" bug by
 * construction. Cached because it cannot change — the escrow's `usdc` is
 * immutable.
 */
let cachedUsdc: Address | null = null;

export async function usdcAddress(): Promise<Address> {
  if (cachedUsdc === null) {
    cachedUsdc = (await publicClient().readContract({
      ...ESCROW,
      functionName: 'usdc',
    })) as Address;
  }
  return cachedUsdc;
}

/** Format a USDC base-unit amount for display, e.g. `1500000n` → `1.50`. */
export function formatUsdc(amount: bigint, opts?: { withSymbol?: boolean }): string {
  const s = formatUnits(amount, USDC_DECIMALS);
  // Two decimals is what a price needs; keep a third only when it is non-zero
  // so an odd bond amount is not silently rounded away.
  const [whole, frac = ''] = s.split('.');
  const trimmed = frac.length > 2 && frac[2] !== '0' ? frac.slice(0, 3) : frac.slice(0, 2);
  const out = trimmed.length > 0 ? `${whole}.${trimmed.padEnd(2, '0')}` : `${whole}.00`;
  return opts?.withSymbol === false ? out : `${out} USDC`;
}

/** Parse a user-typed USDC amount into base units. Throws on malformed input. */
export function parseUsdc(input: string): bigint {
  const clean = input.trim();
  if (clean === '') throw new Error('Enter an amount.');
  if (!/^\d*\.?\d*$/.test(clean)) throw new Error('Use digits and a single decimal point.');
  const value = parseUnits(clean, USDC_DECIMALS);
  if (value <= 0n) throw new Error('Amount must be greater than zero.');
  return value;
}
