/**
 * Redirects bare `viem` and `genlayer-js/chains` imports to test stubs.
 *
 * Node resolves a module graph before evaluating any of it, so a test file
 * cannot install this hook itself — it has to run first, which is what the
 * `--import` flag is for:
 *
 *     node --import ./relayer/test/register.mjs --test relayer/test/pure.test.ts
 *
 * `registerHooks` is synchronous and in-thread, so it applies to the test file's
 * own graph. It deliberately does not map `genlayer-js` itself: nothing in the
 * pure tests needs the SDK client, and an accidental import should fail with the
 * real module-not-found rather than a stub that pretends to work.
 */

import { registerHooks } from 'node:module';

const STUBS = {
  viem: new URL('./stubs/viem.ts', import.meta.url).href,
  'genlayer-js/chains': new URL('./stubs/genlayer-chains.ts', import.meta.url).href,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub !== undefined) {
      return { url: stub, format: 'module-typescript', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
