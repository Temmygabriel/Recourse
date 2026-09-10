/**
 * A stand-in for `genlayer-js/chains`, for testing chain resolution offline.
 *
 * These are transcriptions of the real definitions from genlayer-js 2.0.0-rc.1.
 * They were read out of the published tarball rather than recalled, and the
 * header comment on each records what was observed.
 *
 * WHAT THIS STUB CAN AND CANNOT PROVE. It cannot prove the ids are right — if a
 * number here were wrong, the test would agree with the wrong number. What it
 * does prove is that the *resolution logic* behaves: that the doc's spelling
 * "studio-dev" reaches the devnet, that an unknown name fails with a message
 * naming the real exports, and — the reason this file exists — that resolving
 * chain id 4221 refuses to pick between Asimov and Bradbury instead of silently
 * returning whichever came first. That last one is pure logic and would be a
 * coin flip in production.
 *
 * `id` is the only field the resolver reads, but the shape mirrors the real
 * objects closely enough that a future change to the resolver's assumptions
 * about them shows up here.
 */

export const localnet = {
  id: 61127,
  name: 'Genlayer Localnet',
  rpcUrls: { default: { http: ['http://localhost:4000/api'] } },
};

export const studioDevnet = {
  ...localnet,
  id: 61997,
  name: 'GenLayer Studio Devnet',
  rpcUrls: { default: { http: ['https://studio-dev.genlayer.com/api'] } },
  // The stable Studio explorer does not index this preview deployment.
  blockExplorers: undefined,
};

export const studionet = {
  ...localnet,
  id: 61999,
  name: 'Genlayer Studio Network',
  rpcUrls: { default: { http: ['https://studio.genlayer.com/api'] } },
};

// Both public testnets declare id 4221 in this release — see the note in the
// test file. This is transcribed, not invented.
export const testnetAsimov = {
  ...localnet,
  id: 4221,
  name: 'Genlayer Asimov Testnet',
  rpcUrls: { default: { http: ['https://rpc-asimov.genlayer.com'] } },
};

export const testnetBradbury = {
  ...localnet,
  id: 4221,
  name: 'Genlayer Bradbury Testnet',
  rpcUrls: { default: { http: ['https://rpc-bradbury.genlayer.com'] } },
};
