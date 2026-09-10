/**
 * A tiny stand-in for the parts of viem the relayer's pure modules use.
 *
 * WHY THIS EXISTS. This project is developed on a machine that cannot run
 * `npm install` (MEMORY.md: 8 GB, no heavy compute). Everything the relayer
 * does that touches Base or GenLayer therefore cannot run here — but the parts
 * that do not touch either chain still can, and those parts are where the
 * subtle bugs live: the commitment hashes, the EIP-712 struct encoding, the
 * verdict parser, and the coherence check that must agree with Solidity.
 *
 * Rather than leave all of that unverified until CI, the pure modules are run
 * against this stub with Node's own TypeScript support (`node test/pure.test.ts`,
 * no build, no dependencies). The stub is deliberately *not* a general viem
 * implementation — it covers exactly the encoding rules those modules use, and
 * nothing else. Anything it does not cover fails loudly rather than silently
 * returning something plausible.
 *
 * The risk of a stub is that it is wrong in the same way the code under test is
 * wrong, which would make the tests meaningless. Two things keep that honest:
 *
 *   - `keccak256` is imported from scripts/gen-wallet.mjs, which verifies
 *     itself against published digest and address vectors via `--self-test`.
 *     It is the one Keccak-256 in this repo known to be correct.
 *   - The hash vectors in docs/vectors/hash-vectors.json were produced by
 *     node:crypto and independently cross-checked against Python's hashlib, so
 *     the sha256 side is pinned to something outside this repo entirely.
 */

import { keccak256 as keccakBytes } from '../../../scripts/gen-wallet.mjs';

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

function stripHex(h: string): string {
  return h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
}

function toBytes(data: Hex | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const h = stripHex(data);
  if (h.length % 2 !== 0) throw new Error(`hex string has an odd length: ${data}`);
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error(`not a hex string: ${data}`);
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

function toHex(data: Uint8Array): Hex {
  return `0x${Buffer.from(data).toString('hex')}`;
}

/** Same contract as viem's keccak256 for our uses: hex or bytes in, hex out. */
export function keccak256(data: Hex | Uint8Array): Hex {
  return toHex(keccakBytes(toBytes(data)));
}

export function concatHex(values: readonly Hex[]): Hex {
  return `0x${values.map(stripHex).join('')}`;
}

export function stringToHex(s: string): Hex {
  return `0x${Buffer.from(s, 'utf8').toString('hex')}`;
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** EIP-55, using the same keccak the rest of this stub relies on. */
export function getAddress(address: string): Address {
  if (!isAddress(address)) throw new Error(`Invalid address: ${address}`);
  const lower = stripHex(address).toLowerCase();
  const hash = stripHex(keccak256(stringToHex(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i] as string, 16) >= 8 ? (lower[i] as string).toUpperCase() : lower[i];
  }
  return out as Address;
}

// --- ABI encoding (static types only, which is all the relayer uses) --------

function word(value: bigint): string {
  if (value < 0n) throw new Error('ABI encoding of negative values is not supported here');
  return value.toString(16).padStart(64, '0');
}

function encodeWord(type: string, value: unknown): string {
  if (type === 'bool') return word(value === true ? 1n : 0n);
  if (type === 'address') {
    if (typeof value !== 'string' || !isAddress(value)) throw new Error(`bad address: ${String(value)}`);
    return stripHex(value).toLowerCase().padStart(64, '0');
  }
  if (type === 'bytes32') {
    if (typeof value !== 'string') throw new Error(`bytes32 must be a hex string, got ${typeof value}`);
    const h = stripHex(value);
    if (h.length !== 64) throw new Error(`bytes32 must be 32 bytes, got ${h.length / 2}`);
    return h.toLowerCase();
  }
  if (/^uint\d+$/.test(type)) {
    const n = typeof value === 'bigint' ? value : BigInt(value as number | string);
    const bits = Number(type.slice(4));
    if (n >= 1n << BigInt(bits)) throw new Error(`${type} value out of range: ${n}`);
    return word(n);
  }
  throw new Error(`this test stub does not implement the ABI type "${type}"`);
}

/** `abi.encode` for static types: every value is one 32-byte word. */
export function encodeAbiParameters(
  types: readonly { type: string }[],
  values: readonly unknown[],
): Hex {
  if (types.length !== values.length) {
    throw new Error(`encodeAbiParameters: ${types.length} types but ${values.length} values`);
  }
  return `0x${types.map((t, i) => encodeWord(t.type, values[i])).join('')}`;
}

/**
 * `abi.encodePacked` for static types.
 *
 * Only the two cases the relayer actually uses are implemented, and both are
 * fixed-width, so the ambiguity that makes `encodePacked` dangerous with
 * adjacent dynamic types does not arise.
 */
export function encodePacked(types: readonly string[], values: readonly unknown[]): Hex {
  if (types.length !== values.length) {
    throw new Error(`encodePacked: ${types.length} types but ${values.length} values`);
  }
  return `0x${types
    .map((type, i) => {
      const value = values[i];
      if (type === 'bytes32') return stripHex(String(value)).toLowerCase();
      if (type === 'uint256') return word(BigInt(value as bigint));
      throw new Error(`this test stub does not implement encodePacked for "${type}"`);
    })
    .join('')}`;
}
