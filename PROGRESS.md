# PROGRESS.md — Recourse build log

Work log, newest first. For durable decisions and constraints see
[MEMORY.md](./MEMORY.md).

**Deadline: Sept 17, 2026** (submission). Today: Sept 10, 2026.

---

## Status at a glance

| Area | State |
|:--|:--|
| Repo scaffold | 🟢 done |
| Base escrow contract | 🟡 written, **unverified** (needs CI compile) |
| Escrow tests | 🟡 written, **unverified** (needs CI run) |
| GenLayer judgment contract | 🟡 syntax-checked locally; **SDK surface unverified** (needs `genvm-lint`) |
| Judgment logic tests | 🟢 **passing locally** (11/11) |
| Cross-language hash vectors | 🟢 done and locked from both sides |
| Relayer | 🟢 written; **30/30 pure-logic tests passing locally**; SDK surface verified against the published package |
| Frontend (7 screens) | 🔴 not started |
| CI (GitHub Actions) | ⚠️ file written, **cannot push** — token lacks `workflow` scope |
| README / security narrative | 🟡 partly written |
| GitHub push wired up | 🟢 working (code pushes fine; only `.github/workflows/` is blocked) |
| Vercel deploy | 🔴 not started |

Legend: 🔴 not started · 🟡 in progress · 🟢 done · ⚠️ blocked

> **No Solidity in this repo has ever been compiled.** It is written against the
> spec and read line-by-line, but this machine cannot run `forge build`, and CI
> cannot run until the `workflow` scope is granted. Treat the escrow and its
> tests as "not yet known to build". The Python side is better off: the
> deterministic logic has been executed (see below), but the GenVM SDK surface
> is still unverified.
>
> **The relayer is verified where it can be.** Everything it does that does not
> touch a chain — the commitment hashes, the verdict parser, the coherence check
> that has to agree with Solidity, the nonce derivation, chain resolution, the
> state store — runs locally with no dependencies and no network (30 tests). The
> parts that do touch a chain are unverified until a deploy exists.

---

## 2026-09-10 — Session 5

### Done

- **Wrote the relayer end to end** — `relayer/` now contains the watcher that
  carries a disputed purchase from Base Sepolia to Studio Devnet and the verdict
  back. Ten source modules: `config`, `log`, `hashes`, `abi`, `escrow`,
  `package`, `decision`, `genlayer`, `store`, `index`. Design notes are in
  `relayer/README.md`; the load-bearing choices are that the nonce is derived as
  `keccak256(genlayerTxHash, purchaseId)` so a retry is idempotent by
  construction, that commitments are verified against the escrow's own views
  *before* the GenLayer fee is spent, and that the decision is simulated against
  the real escrow *before* it is signed.

- **Found a way to test the relayer on this machine.** Node 24 runs TypeScript
  directly, so with a module-resolution hook (`relayer/test/register.mjs`) and a
  small `viem` stub, the chain-independent logic executes here with no `npm
  install` — the same trick that worked for the Python contract. The stub's
  keccak256 is imported from `scripts/gen-wallet.mjs`, which checks itself
  against published digest and address vectors, so the hash assertions rest on
  something outside this repo rather than on a second implementation that might
  be wrong in the same way. **30/30 passing.**

- **Verified the genlayer-js surface against the published package instead of
  against the docs — and the docs were wrong.** Downloaded
  `genlayer-js@2.0.0-rc.1` (`npm pack`, no install) and read its `dist/`. Two
  findings that would each have cost a debugging session:
  - The migration doc calls the preview chain **`studio-dev`**, but the package
    exports **`studioDevnet`**. There is no hyphenated export.
  - **`testnetAsimov` and `testnetBradbury` both declare `id: 4221`.** The old
    id-based chain fallback would have returned whichever came first in key
    order — a silent coin flip between two networks, surfacing much later as a
    `sourceChainId` mismatch. `resolveChain` now refuses to resolve an ambiguous
    id and says which names collided.
  Also confirmed: `genlayer-js@2.0.0-rc.1` really is published (it resolved in
  the lockfile), and every client method the relayer calls exists with the
  signature assumed — `readContract`, `writeContract`, `waitForFinalization`,
  `estimateTransactionFeesForWrite`, `getAppealCharge`, `appealTransaction`. The
  enums are the exception: `TransactionStatus` / `ExecutionResult` /
  `TransactionHashVariant` are runtime values only from `genlayer-js/types`, not
  from the main entry, where importing them typechecks and then yields
  `undefined`. The relayer duck-types and never imports them, so it was
  unaffected.

- **Generated `relayer/package-lock.json`** with `npm install --package-lock-only`
  — metadata resolution only, no packages downloaded, cheap enough for this
  machine. CI can now use `npm ci` and npm caching.

### Caught and fixed

- **A test of mine asserted something false about the rubric hash.** I had
  written `assert.notEqual(rubricHashHex(['a','b']), rubricHashHex(['a\nb']))`.
  They are equal — the preimage is the joined text, so `['a','b']` and
  `['a\nb']` are the same bytes. Rather than delete the assertion, it is now an
  explicit `assert.equal` documenting a **known limitation of the shared
  commitment scheme**: a newline inside a rubric item is indistinguishable from
  an item boundary. It is not exploitable here (the rubric array lives on-chain
  and is set by the seller, and the relayer is trusted in this prototype), and
  closing it would invalidate the locked vectors, so it is recorded rather than
  changed. See the comment on that test.
- **`tsconfig.json` could not accept the sources' `.ts` import specifiers.**
  Node's type stripping does not map `./x.js` back to `./x.ts`, so every
  relative import was rewritten to `.ts` — which then fails `tsc` unless
  `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` are on. Both
  need TypeScript ≥ 5.7; the devDependency said `^5.6.0` and is now `^5.7.0`
  (the lockfile resolves 5.9.3). CI also greps `dist/` for leftover `.ts`
  specifiers, because if the rewrite silently did not apply, the build would
  succeed and `npm start` would fail.

### Blocked

- **Still `gh auth refresh -s workflow`.** Third session running. `ci.yml` stays
  local-only via `.git/info/exclude`; everything else is unaffected.

### Next

- Frontend (task #6): 7 screens, inspection-record theme.
- Then the deploy runbook and README (task #8), then Vercel.

---

## 2026-09-10 — Session 4

### Done

- **Found a real interop bug by reading the judgment contract against the
  escrow.** The escrow commits `sha256(bytes(stored_text))` over the text
  *verbatim*; the judgment contract was `.strip()`-ing its fields before hashing
  them. A promise ending in a newline — which a textarea produces routinely —
  would have failed the hash check, raising `UserError` on every attempt and
  leaving that dispute **permanently unjudgeable**. Fixed: the contract now
  hashes exactly what arrived and cleans text only for the prompt, after the
  hash check has passed. `_clip` (which trimmed and truncated) was replaced by
  `_require_str` / `_require_rubric_item`, which reject rather than repair.
- **Built cross-language hash vectors** — `scripts/gen-hash-vectors.mjs` is the
  single source; it emits `docs/vectors/hash-vectors.json` for the Python side
  and `contracts/test/HashVectors.generated.sol` for the Solidity side. Every
  vector is a case where normalising would change the bytes: trailing newlines,
  leading/trailing spaces, interior tabs, a rubric item whose own text ends in a
  space, and non-ASCII (accents and emoji, which also pins UTF-8 encoding
  agreement). CI regenerates and `git diff --exit-code`s them so the two sides
  cannot drift.
- **Wrote `genlayer/tests/test_judgment_logic.py`** — runs the contract's real
  deterministic code with a minimal SDK stub, no pytest, no network:
  `python genlayer/tests/test_judgment_logic.py`. **All 11 pass.** Covers the
  hash vectors, the verbatim-bytes regression, `_as_int`'s bool rejection, the
  proportional-refund bounds, the full `_clamp` repair table — and an
  **exhaustive property test**: every outcome × every criteria pattern (2–4
  criteria) × a spread of refund percentages including out-of-range ones, with a
  Python transcription of the escrow's `_checkVerdictCoherence` asserting the
  escrow would accept every verdict `_clamp` can produce. The failure it guards
  against is a settlement attempt burnt on a well-formed but rejected verdict.
- **Added three Foundry tests against the same vectors**, exercising the real
  code paths (`promiseHash`, `deliveryHash`, `disputeHash`, `rubricHash`) rather
  than asserting `sha256` directly — plus one test stating the counterexample:
  whitespace *must* change the hash.
- **Corrected `docs/DATA_MODEL.md` §3**, which documented a `delivery_hash`
  formula the contract does not implement and said nothing about the verbatim
  invariant.

### Caught and fixed

- **`_clamp` refunded 0.01% for a broken promise.** When the model returned
  `PARTIAL_REFUND` with unmet criteria but no usable `refund_bps`, the code
  clamped the missing value up from 0 to 1 basis point — refunding a hundredth
  of a percent on a promise that was demonstrably not kept, which is a worse
  outcome than either neighbouring row of the repair table. Found by the repair
  table test. Now: a missing or non-positive percentage is derived from the
  model's own criteria list, the same treatment the `RELEASE` row already gives
  a label that disagrees with its own `criteria_met`.
  (`_as_int`'s default changed from `0` to `-1` so "supplied no number" is
  distinguishable from "supplied zero".)
- **`test_clamp_repair_table` had two duplicate rows** after an editing slip —
  removed.

### Blocked / needs the user

- **`gh auth refresh -s workflow`** — re-verified this session, still
  `Token scopes: 'gist', 'read:org', 'repo'`. This is the critical path: it is
  the only thing standing between "written" and "known to build".
  ```
  gh auth refresh -s workflow        # gh is at C:\Users\USER\AppData\Local\gh-install\bin\
  ```

### Next

1. Push once the `workflow` scope lands, and read the first CI run carefully.
2. Relayer service (task #5).

---

## 2026-09-10 — Session 3

### Done

- **Wrote the Foundry test suite** — `contracts/test/RecourseEscrow.t.sol`,
  ~90 tests, plus `contracts/test/mocks/MockUSDC.sol` (the real Circle testnet
  token has no public `mint`, so a test that needs a funded buyer cannot use
  it). Coverage, grouped as the file groups it:
  - **Happy path** — offer → fund → deliver → accept, and the derived hashes.
  - **All four outcomes**, asserting the exact payout *and* bond movement for
    each, per the table in `docs/DATA_MODEL.md` §6. Two fuzz tests pin that the
    split sums to exactly the price — `assertEq(usdc.balanceOf(escrow), 0)` —
    because any integer-division dust would be stranded permanently in a
    contract with no sweep function and no upgrade path.
  - **Replay** — byte-identical resubmission, fresh nonce on a settled purchase,
    and a nonce spent on one purchase reused on another.
  - **Authorisation** — wrong signing key, valid signature from a stranger,
    tampered outcome / bps / nonce, malformed signature length, the high-`s`
    malleability variant, wrong `v`, and signature reuse after a relayer
    rotation.
  - **Decision context** — `finalized=false`, wrong source chain, wrong source
    contract, mismatched promise / rubric / evidence root, cross-purchase
    relabelling, unknown purchase.
  - **Verdict coherence** — every incoherent combination, and the bitmap range
    check against all four outcomes (it is not inside one branch).
  - **State machine** — every illegal transition.
  - **Timeouts** — review timeout (including that a permissionless caller
    cannot redirect the payout), deadline refund, and that the review window
    runs from *delivery*, not purchase.
  - **Bounds** — every documented limit, tested at the boundary and one past it.
  - **Admin** — pause blocks new offers/purchases/disputes/settlements but
    **not** `acceptDelivery` or `claimDeadlineRefund` (pausing must not trap
    money already in flight), and `test_OwnerHasNoPathToFunds` exercises every
    admin function while asserting the escrow balance never moves.
  - **Identity** — EIP-712 domain separator against a hand-built expectation,
    and a second identically-configured escrow rejecting this escrow's
    signatures (which is the domain separator doing its job).

### Caught and fixed

- **The `settle()` authorisation gate was signature-only.** Build spec §4.7
  says only the verified relayer signature may call settlement; §4.1 says verify
  the relayer's message. The contract verified the signature but never checked
  `msg.sender`, which makes settlement *permissionless* — a decision the relayer
  signed and then thought better of could be pushed by anyone who saw it.
  Added `require(msg.sender == relayer)`. Both gates are now tested separately.
- **Three test expectations were wrong against the real contract**, all caught
  by reading `settle()` rather than by running (which is not possible here):
  a tampered-outcome fixture that still tripped a *coherence* check before
  reaching the signature check; a cross-purchase replay where both purchases had
  identical evidence, so nothing distinguished them; and fixtures built *after*
  `pause()`, which `createOffer`/`openDispute` correctly reject.
- **CI could not have run the tests.** `contracts/lib/` is gitignored, so
  `forge test` would have failed on missing `forge-std`. Added
  `forge install foundry-rs/forge-std --no-commit` to the contracts job — the
  escrow itself still imports nothing external.

### Decisions made this session

D10 (two gates on `settle`) and D11 (`forge-std` installed by CI, not
committed) in [MEMORY.md](./MEMORY.md).

### Blocked / needs the user

- **`gh auth refresh -s workflow`** — still outstanding after being asked for
  last session. Verified again this session:
  `Token scopes: 'gist', 'read:org', 'repo'`. Without `workflow`, the CI file
  cannot be pushed, so **nothing in `contracts/` or `genlayer/` can be
  compiled or linted at all**. This is now the critical path: every remaining
  contract is being written blind until CI runs once.
  ```
  gh auth refresh -s workflow        # gh is at C:\Users\USER\AppData\Local\gh-install\bin\
  ```

### Next

1. Push once the `workflow` scope lands, and read the first CI run carefully —
   expect compile errors in code that has never seen a compiler.
2. Relayer service: watch GenLayer for a finalized verdict, assemble the
   `SettlementDecision`, sign with the relayer key, submit to Base.
3. Frontend, starting with the hero screen (promise-vs-evidence comparison).

---

## 2026-09-10 — Session 2

### Done

- **Wrote `contracts/src/RecourseEscrow.sol`** — the core artifact. Solidity
  0.8.24, zero external imports, `evm_version = paris`.
  - Four design rules stated in the header: the contract owns the hashes; one
    settlement ever; no admin path to the money; the trust boundary is named,
    not hidden.
  - Full state machine (`NONE/OPEN/FUNDED/DELIVERED/DISPUTED/SETTLED`), USDC in
    and out, dispute bond, EIP-712 `SettlementDecision` verification with a
    nonce ledger, and a 16-item documented rejection list in `settle()`.
  - `_checkVerdictCoherence()` enforces that a verdict is internally consistent
    even when its signature is valid — a compromised relayer key or a decoder
    bug still cannot produce a self-contradicting payout.
  - Admin is pause + relayer rotation + ownership transfer. None can move a
    token.
- **Wrote `genlayer/contracts/recourse_judgment.py`** — the judgment layer.
  Pinned `Depends` header, module-level pure helpers so the nondet block touches
  no `self`, a hardened prompt that fences party text before *and* after the
  rules, and a `_clamp` repair table so an incoherent LLM answer is repaired
  into a coherent one rather than propagated.
- **Moved both specs to `docs/specs/`**, wrote `.gitattributes`, wrote
  `.github/workflows/ci.yml` (4 jobs: contracts, genlayer, frontend, relayer —
  the last two guarded so they skip honestly rather than pass falsely).
- **Pushed to `main`.** Code landed; `.github/workflows/ci.yml` did **not** —
  the OAuth token lacks the `workflow` scope.

### Caught and fixed

- `p.stage_settled_guard()` in `settle()` was not valid Solidity — a call to a
  non-existent method on a storage struct. Removed; folded into the
  `stage == DISPUTED` require.
- Missing the `met != full` check on the `FULL_REFUND` branch — a full refund
  that admits every criterion was met is self-contradicting.
- The GenLayer contract's `evidence_root` check compared a value to itself.
  Removed it and rewrote the module docstring to say accurately that the
  judgment contract verifies only *package internal consistency* — the
  authoritative purchase binding is `RecourseEscrow.settle()`.
- `hashlib` / `self` usage inside the nondet block, and
  `TreeMap.get(key, default)` (not a safe assumption) — both replaced.

### Next

1. Foundry tests for the escrow, including the attack paths.
2. Get the `workflow` scope so CI can run.

---

### Done

- **Read and studied both specs** (`recourse_build_spec.md`,
  `recourse_design_spec.md`) and the GenLayer
  [Consensus v0.6 migration doc](https://docs.genlayer.com/developers/consensus-v06-migration).
  Distilled the v0.6 items that actually change our code into
  [MEMORY.md](./MEMORY.md).
- **Confirmed the GitHub repo is empty** and publicly readable.
- **Confirmed local toolchain gaps:** no `gh`, no `winget`, no Vercel CLI, no
  git credentials. → push and deploy paths still open.
- **Wrote the data model** — [docs/DATA_MODEL.md](./docs/DATA_MODEL.md).
  Fixes field names, bounds, hash formulas, the state machine, and the
  rationale for the `UNDETERMINED` payout policy.
- **Wrote and verified the key generator** — `scripts/gen-wallet.mjs`.
  Pure Node, no dependencies, implements Keccak-256 + secp256k1 address
  derivation. Verified against 4 Keccak vectors, 3 published private-key →
  address vectors, and a multi-block absorb test. **All pass.**
- **Generated the testnet keys** into `.secrets/` (gitignored, confirmed with
  `git check-ignore`).
  - Deployer `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b`
  - Relayer `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037`
- **Wrote `.gitignore`**, **`MEMORY.md`**, **`PROGRESS.md`**.

### Caught and fixed

- **Keccak rotation table was transposed.** The first generated addresses were
  wrong — plausible-looking, self-consistent, and would have sent faucet funds
  to an address nobody holds the key to. Caught by adding published
  private-key → address vectors rather than trusting a smoke test that only
  checked "does the hash change when the input changes". Fixed in
  `scripts/gen-wallet.mjs`; the comment there explains why the array looks like
  a transpose of the published table.

### Decisions made this session

D1–D9 in [MEMORY.md](./MEMORY.md). The ones worth flagging:

- Escrow holds **real Base Sepolia USDC** (user's call).
- Solidity ships with **zero external dependencies** so `forge build` works
  from a clean clone with no submodule fetch.
- **Text on-chain as strings, hashes derived by the contract** — the frontend
  never computes a hash, so it cannot desync from the chain.
- **`UNDETERMINED` pays the seller and returns the bond to the buyer.**
  Reasoning in `docs/DATA_MODEL.md` §6.

### Blocked / needs the user

- **GitHub push.** `gh` is not installed and there is no `winget` on this
  machine. The user believed this was done; it is not. Options are in the
  session notes — easiest is downloading the `gh` MSI directly, or supplying a
  PAT.
- **Faucet funds.** The user offered to source faucet tokens. Needed once the
  escrow address is known: Base Sepolia ETH (gas) + Base Sepolia USDC on the
  deployer `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b`, and Base Sepolia ETH
  on the relayer `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037`.

### Next

1. Write `contracts/src/RecourseEscrow.sol` — full state machine, USDC in/out,
   bond economics, EIP-712 `SettlementDecision` verification, nonce replay
   guard, pause-only admin.
2. Write the Foundry test suite including the attack paths (replay,
   double-settle, bad signature, mismatched hashes, wrong source chain).
3. GitHub Actions CI so the build/test runs on a runner, not this machine.
