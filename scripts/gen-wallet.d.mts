/**
 * Types for scripts/gen-wallet.mjs.
 *
 * That file is plain JavaScript with no build step — it has to run on a bare
 * `node scripts/gen-wallet.mjs` with no `npm install` — so it cannot carry its
 * own type annotations. This declaration file sits beside it and gives
 * TypeScript the shapes, which matters because the relayer's test stub imports
 * `keccak256` from it. Without this, that import is an implicit `any` and the
 * hash assertions in relayer/test/pure.test.ts would be built on an untyped
 * call.
 */

/** Keccak-256 (Ethereum's variant, 0x01 padding — not NIST SHA3's 0x06). */
export declare function keccak256(input: Uint8Array): Uint8Array;

/** EIP-55 mixed-case checksum encoding of a 20-byte hex address. */
export declare function toChecksumAddress(addr: string): string;

/** Derive the checksummed address for a 32-byte private key (hex, with or without 0x). */
export declare function addressFromPrivateKey(privHex: string): string;

/** Published keccak256(text) -> digest vectors. */
export declare const VECTORS: readonly (readonly [string, string])[];

/** Published privateKey -> address vectors; these exercise keccak256 and secp256k1 together. */
export declare const ADDRESS_VECTORS: readonly (readonly [string, string])[];

/** Verify keccak256 and address derivation against the published vectors. Returns true if all pass. */
export declare function selfTest(): boolean;
