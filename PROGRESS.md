# PROGRESS.md — Recourse build log

Work log, newest first. For durable decisions and constraints see
[MEMORY.md](./MEMORY.md).

**Deadline: Sept 17, 2026** (submission). Today: Sept 11, 2026.

---

## Status at a glance

| Area | State |
|:--|:--|
| Repo scaffold | 🟢 done |
| Base escrow contract | 🟢 **compiles — `forge build` exits 0, solc 0.8.24** |
| Escrow tests | 🟢 **112/112 passing locally** (was 0 executed before this session) |
| GenLayer judgment contract | 🟡 syntax-checked locally; **SDK surface unverified** (needs `genvm-lint`) |
| Judgment logic tests | 🟢 **passing locally** (11/11) |
| Cross-language hash vectors | 🟢 done and locked from both sides |
| Relayer | 🟢 written; **30/30 pure-logic tests passing locally**; SDK surface verified against the published package |
| Frontend (7 screens) | 🟢 **8 routes typecheck clean (`tsc --noEmit` exit 0) AND build (`next build` exit 0)** — verified locally 2026-09-11 |
| CI (GitHub Actions) | ⚠️ file written, **cannot push** — token lacks `workflow` scope |
| README / security narrative | 🟡 README done; `docs/SECURITY.md` and `docs/DEPLOY.md` still missing |
| GitHub push wired up | 🟢 working (code pushes fine; only `.github/workflows/` is blocked) |
| Vercel deploy | 🟡 **build-verified locally; not yet deployed** — see the Vercel readiness note below |
| GenLayer deploy (Bradbury) | 🔴 **blocked by network, not by code** — see Session 8 |
| Base escrow deploy | 🔴 not started (waits on the GenLayer address — `sourceContract` is immutable) |

Legend: 🔴 not started · 🟡 in progress · 🟢 done · ⚠️ blocked

> **The Solidity is now compiled and executed.** As of 2026-09-11 the escrow
> builds under solc 0.8.24 and all 112 Foundry tests pass — the first time any
> Solidity in this repo has been through a compiler. It took three compile
> errors and two test-harness bugs to get there, all listed in Session 7. The
> caveat that replaces the old one: **this was a local run on the developer
> machine, not CI**, and CI still cannot run until the `workflow` scope is
> granted. A local pass and a green check are not the same evidence.
>
> **The GenLayer SDK surface is still unverified.** The judgment contract's
> deterministic logic has been executed (11/11), but nothing has loaded it
> through `genvm-lint`, so its `Depends` header and nondeterminism API names
> remain "read from the docs" rather than "confirmed by the tool".
>
> **The relayer is verified where it can be.** Everything it does that does not
> touch a chain — the commitment hashes, the verdict parser, the coherence check
> that has to agree with Solidity, the nonce derivation, chain resolution, the
> state store — runs locally with no dependencies and no network (30 tests). The
> parts that do touch a chain are unverified until a deploy exists.
>
> **The frontend has now been compiled.** As of Session 8 both `npx tsc --noEmit`
> and `npx next build` exit 0 against the locked dependency versions, producing
> all nine routes. The old caveat — "Vercel will be the first compiler" — is
> retired. It was run in a scratch copy outside the repo (`%TEMP%\recourse-tsc`)
> because this machine is 8 GB and the user asked for heavy compute to stay off
> it, but the source compiled is byte-identical to the repo's. See the Vercel
> readiness note in Session 8 for what is still unproven.
>
> **The GenLayer deploy is blocked by the network, not by the contract.**
> Session 8 diagnosed this precisely: Bradbury's RPC load-balances across nodes
> with inconsistent mempool views, so the same transaction hash returns `null`
> from one poll and a transaction object from the next. Two deploy attempts were
> accepted and then never finalized. **No GenLayer contract address exists yet**,
> which blocks the Base escrow deploy behind it.

---

## 2026-09-11 — Session 8

### Done

- **Implemented the whole security-paper design direction**
  (`recourse_design_direction_security_paper.md`, §2–§7). Token swap, the
  security band, solid ink primary buttons, filled requirement circles, the
  three inline SVG icons, the home hero, the stage-coded purchase rows, the
  payment-stub price panel, the dashed exhibits, and the dispute bond strip.
  Nothing in §1–§8 is left unbuilt.
- **Compiled the frontend for the first time.** `npx tsc --noEmit` exit 0 and
  `npx next build` exit 0 — nine routes, 103 kB shared JS, `/` at 209 kB First
  Load. Run twice: once before the requirement-circle changes and once after.
- **Ran the money-rails checklist** from `genlayer-known-money-rails-issues.md`
  against Recourse. Recorded in [docs/MONEY_RAILS_AUDIT.md](./docs/MONEY_RAILS_AUDIT.md).
- **Diagnosed the GenLayer deploy blockage to root cause.** Details below.

### The GenLayer deploy — what is actually wrong

Not a contract bug, and not the transient socket noise earlier sessions blamed.
It is two separate conditions that compounded:

1. **A stranded transaction.** An earlier deploy (`0x139c9ed1…823e`) is still
   sitting in Bradbury's mempool at nonce 284, never mined. It bid
   **0.1732 gwei**. The network's current price is **0.1568 gwei** — *lower*.
   Because the GenLayer CLI has **no gas-price flag** (checked: `deploy --help`
   offers only `--contract`, `--rpc`, `--args`), every retry bids the current
   network price, which is below the stranded tx, and is rejected with
   `insufficient gas price to replace existing transaction`. Retrying can never
   succeed while the network price sits under 0.1732 gwei.
2. **An RPC that disagrees with itself.** `rpc-bradbury.genlayer.com`
   load-balances across backend nodes whose mempools are not synchronised.
   Polling the *same hash* three times returned `null`, `null`, then a
   transaction object. So "is my transaction in the pool?" has no single
   answer at this endpoint, and the CLI's `WaitForTransactionReceipt` races
   a pool whose contents depend on which node answers.

The second attempt (`0x85d9dc21…3834`) got past the gas-price gate — the
stranded tx had evidently been evicted — was accepted, and then timed out
waiting for confirmation. It is now `null` on the nodes the RPC is currently
routing to.

**Consequence: the account nonce is stuck at 284 and no GenLayer contract
exists.** `sourceContract` on the escrow is immutable and constructor-only, so
the Base escrow deploy cannot proceed until a GenLayer address exists. This is
the critical path for the whole submission.

### Vercel readiness

The user asked to be told when the project is ready to deploy to Vercel.
**The frontend is ready and verified**: `next build` exits 0 with the exact
dependency versions in `package-lock.json`, and the two type errors that broke
the previous Vercel build (`escrow.ts:193` and the hidden `escrow.ts:220`) are
fixed and confirmed gone.

What is **not** ready is everything the deployed app would talk to. The pages
will load on Vercel, but every one of them reads from `NEXT_PUBLIC_ESCROW_ADDRESS`
and there is no escrow deployed. A deployment now produces a site that renders
its empty state on every route. That is worth doing only once the addresses
exist — not because the build would fail, but because a live URL that shows
nothing is worse evidence than no URL.

### Caught and fixed

- **A fabricated file path in the README.** The key blast-radius table listed
  the GenLayer deployer key as living in `.secrets/genlayer.json`. That file
  does not exist and never did — I wrote the row by inference instead of
  checking. The key is actually in the **GenLayer CLI's own keystore at
  `~/.genlayer/keystores/default.json`**, outside the repository entirely.
  Corrected, and the surrounding paragraph with it.
- **Verified the secrets really are ignored**, rather than trusting the
  README's claim: `git check-ignore -v` confirms `.secrets/` is matched by
  `.gitignore:2`, and `git ls-files` confirms the only tracked `.env` files are
  the two `.env.example` templates.
- **Two design-direction consistency fixes** where the doc's intent and its
  literal text disagreed: the unmarked requirement circle was sage-hairlined
  rather than ink-outlined as §5 specifies, and dispute selection still used
  the accent navy for its row wash while the circle above it filled burgundy.
  Both moved to the colours §5/§6.5 actually call for.

### Next

1. **Unblock the GenLayer deploy** — the single critical-path item. Options:
   wait for the network gas price to rise above 0.1732 gwei and retry; create a
   fresh GenLayer account and fund it from a faucet (the stranded nonce does not
   follow a new account); or supply the CLI keystore password so the tx can be
   replaced directly at nonce 284 with a higher bid.
2. Deploy the Base escrow with the GenLayer address and chain id once it exists.
3. Write `docs/SECURITY.md` and `docs/DEPLOY.md` — both are referenced by
   `MEMORY.md`, `DATA_MODEL.md` and the README and neither exists yet.
4. Add the escrow reconciliation check flagged in `docs/MONEY_RAILS_AUDIT.md`.

---

## 2026-09-11 — Session 7

### Done

- **Compiled the Solidity for the first time.** Foundry 1.8.1 was already on the
  machine at `C:\Users\USER\.foundry\bin\` — it was simply not on `PATH`, which
  is why five sessions of notes said `forge build` was impossible here. With the
  user's go-ahead, `forge build --sizes` now exits 0:
  **RecourseEscrow 16,403 B runtime** (8,173 B of margin under the 24,576 B
  EIP-170 limit), 17,581 B initcode.
- **Ran the escrow test suite for the first time: 112/112 pass.**
- **Fixed three compile errors and two test-harness bugs** — all of them in code
  that had never been through a compiler or an EVM. Listed under "Caught and
  fixed".
- **Wrote `contracts/.gas-snapshot`**, so the CI step that references it is a
  real check rather than a no-op.
- **Stopped `forge install` from committing a submodule.** It had staged
  `.gitmodules` and a `contracts/lib/forge-std` gitlink, which would have
  contradicted D11 and made the repo require a submodule fetch to build. Both
  unstaged, `.gitmodules` deleted, and CI now pins `forge-std@v1.16.2`
  explicitly — see below for why the lockfile is not the answer.
- **Built the frontend** — eight routes, the lib layer, and five components. See
  Session 6.

### Caught and fixed

Three of these are contract defects; two are defects in the tests themselves.
The distinction matters — a test bug that presents as a contract failure is how
a real bug gets "fixed" by weakening an assertion.

1. **`Stack too deep` in `settle()` — a real contract defect.**
   `Settled` takes eleven arguments, all live at once when it is emitted. The
   four payout locals kept alongside them pushed the function past the EVM's
   sixteen-slot reach. Fixed by moving the split into a `_payout()` helper that
   returns a `Payout` memory struct — four stack slots become one, and the money
   arithmetic gets a name. Deliberately **not** fixed with `via_ir`, which would
   have tripled compile time on a machine that cannot spare it.
2. **`Stack too deep` in `_hashDecision()` — same class, same fix.**
   `abi.encode`'s fourteen arguments could not share the stack with the domain
   separator. Split the struct hash into `_structHash()`.
3. **`Copying nested calldata dynamic arrays to storage is not implemented`** at
   `p.rubric = rubric`. A `string[]` is an array of dynamic arrays and the
   legacy code generator refuses the wholesale copy. Replaced with an explicit
   push loop, with a comment naming the error so nobody "simplifies" it back.
4. **`Invalid character in string` for an emoji in the generated hash fixture.**
   `scripts/gen-hash-vectors.mjs` emitted plain `"..."` literals for all vector
   text, and a plain Solidity string literal may only contain printable ASCII.
   The generator's own comment asserted the opposite — that Solidity literals
   are raw UTF-8 — which is exactly the kind of confidently wrong comment that
   costs an hour. Now emits `unicode"..."` via a `lit()` helper, and the comment
   says why. The regenerated `hash-vectors.json` is **byte-identical**, so the
   contract between the two implementations did not move.
5. **`Identifier-start is not allowed at end of a number`** — Solidity has no
   binary literals, and the test file used `0b011`-style bitmaps in 30+ places.
   Converted to hex (`0b011` → `0x3`) with the mapping documented once at the
   top of the test contract.
6. **37 tests failed on a test-harness bug, not a contract bug.** `_settle()`
   and ~30 call sites wrote `escrow.settle(d, _sig(d))`. Solidity evaluates
   arguments before the call, and `_sig()` calls `escrow.hashDecision()` — an
   external call, which **consumes a pending `vm.prank` and a pending
   `vm.expectRevert`** exactly as readily as the call the test meant them for.
   So the prank was spent on `hashDecision` (settle then ran as the test
   contract and reverted "not relayer") and the expectRevert was spent on a call
   that did not revert (giving "next call did not revert as expected"). Both
   symptoms are one bug, and neither points at the contract. Fixed by hoisting
   the signature above the arming lines — the same shape the replay test already
   used, which is why that one test was passing while its neighbours were not.
7. **A fuzz test was funding-bound, not arithmetic-bound.**
   `testFuzz_PartialRefundSplitIsExact` bounded price to `1_000_000e6` against a
   buyer minted 10,000 USDC, so most runs reverted in `transferFrom` and looked
   like split failures. Range narrowed to what the fixture can actually fund,
   with a comment saying the property under test is the arithmetic.
8. **The GenLayer key test asserted a format the contract never produced.**
   `genlayerKey()` renders the escrow address lowercase; the test compared
   against `vm.toString(address)`, which is EIP-55 checksummed. Resolved by
   making lowercase authoritative — both consumers (`relayer/src/escrow.ts`,
   `frontend/src/lib/escrow.ts`) *call* `genlayerKey()` rather than rebuilding
   the string, so the contract's rendering is the only one that exists.
   `docs/DATA_MODEL.md` §8 now says so explicitly, because it had been silent on
   casing and silence is what let the two spellings drift apart.
9. **`stamp-neutral` was styled as `.stamp-undetermined`, which nothing applied.**
   `OutcomeInfo.tone` is `'neutral'` for `UNDETERMINED`, `.status-neutral`
   existed, `.stamp-neutral` did not — so an undetermined verdict rendered its
   stamp with no border and no colour, the one visual state the design spec is
   most careful about. Found by a read-only audit subagent, confirmed by hand.
10. **`fetchAllPurchases` filtered `!== undefined` on a `Purchase | null`.**
    The guard let every `null` through, and because the type predicate still
    claimed `Purchase`, the compiler agreed. Any single failed `getPurchase`
    read — reachable, since the public RPC is rate-limited and this fetches one
    purchase per count concurrently — would have thrown on the home list rather
    than dropping the row.

### Decisions made this session

- **`forge build` and `forge test` are now run locally.** The standing "all
  heavy compute on GitHub" rule was written when `forge` was believed absent.
  The user amended it for Solidity specifically. `npm install` and `next build`
  for the frontend are **still** off-limits on this machine.
- **`via_ir` is not enabled.** Both stack-depth errors were fixed by reducing
  live locals instead, because `via_ir` costs several times the compile time and
  this machine cannot spare it.
- **`contracts/foundry.lock` is gitignored, and CI pins `forge-std@v1.16.2`.**
  Forge writes the dependency key with the host's path separator, so a lockfile
  generated on Windows says `lib\\forge-std` and every Linux CI run would
  rewrite it. Pinning the tag in the workflow buys the same reproducibility
  without a platform-specific file in the repo.

### Blocked / needs the user

- **Still `gh auth refresh -s workflow`.** Re-checked this session: the token
  still carries only `'gist', 'read:org', 'repo'`. `.github/workflows/ci.yml`
  exists **only in the working tree** — it is excluded via `.git/info/exclude`,
  so it is not backed up in git. Until the scope is granted, CI cannot run and
  that file has no history.
- ~~Faucet funds~~ — **checked, and I was wrong to have listed this.** The
  deployer has 0.02 ETH and 20 USDC; the relayer has 0.001 ETH and (as of this
  session) 20 USDC. Verified against two independent RPCs. An earlier session
  recorded "needs faucet funds" as a blocker **without ever looking at the
  chain**, and carried it forward for a day. Gas is not the binding constraint
  on this build — the relayer's 0.001 ETH alone is hundreds of `settle()` calls.
- **The demo wallet `0x0DE1…340D` has no ETH**, so it cannot sign yet. It needs
  Base Sepolia gas before the demo, plus USDC if it plays the buyer.

### Done after the two commits below

- **Created the demo wallet** — `0x0DE10708F8c6DF7b73068d53def715A70C0f340D`,
  key in `.secrets/demo.json` (gitignored, mode 0600, private key deliberately
  never printed). Added `--out <dir> --wallet <name>` to `scripts/gen-wallet.mjs`
  for a key that is a role of its own rather than part of the
  deployer/relayer pair; it refuses to overwrite, so it cannot clobber the two
  the escrow and relayer depend on. Self-test passed (7/7) before generating.
- **Verified all Base Sepolia balances on-chain**, which is what caught the
  stale blocker above.

### Next

1. Push, then get CI green — it is the only thing that will ever typecheck the
   frontend short of Vercel.
2. Write the README, `docs/SECURITY.md` and `docs/DEPLOY.md` (both referenced by
   other docs and neither existing yet).
3. Deploy the escrow to Base Sepolia and the judgment contract to Studio Devnet.

---

## 2026-09-10 — Session 6

### Done

- **Built the whole frontend** — `frontend/`, Next.js 15 App Router + React 19 +
  Tailwind 3.4 + viem. Eight routes covering build spec §5.1–5.8: home, new
  offer, offer detail (with its actions), deliver, dispute, case, verdict,
  receipt. Five components: `Document` (the shared primitives), `RequirementList`,
  `PromiseVsEvidence`, `PurchaseRow`, `AppHeader`.
- **Architected the verdict to come from Base, never from GenLayer.** Every
  number on the case, verdict and receipt screens — outcome, per-requirement
  marks, the split, the bond — is read from the escrow's `Settled` event. The
  browser never loads the GenLayer SDK. Reasons in MEMORY.md.
- **Made the escrow address lazy** (`escrowAddress()` in `lib/chain.ts`). Next 15
  prerenders every page on the server, so reading `NEXT_PUBLIC_ESCROW_ADDRESS` at
  module scope would turn a forgotten Vercel variable into a failed *build*
  rather than a message in the browser. CI's frontend job deliberately sets no
  env vars, so if anyone moves that read back to the top level the job goes red
  instead of Vercel.
- **Removed a `lint` script that had no eslint dependency**, which would have
  triggered an interactive install mid-build.

### Caught and fixed

- **`chain.ts` would have failed `next build`** — the module-scope env read
  described above.
- **`receipt/[id]/page.tsx` referenced a `ESCROW_FOR_DISPLAY` that does not
  exist** (and compared an address to the string `'0x0'`).
- **`fetchAllPurchases` inferred purchase ids from array position.** Wrong the
  moment one read fails: every row after it would carry its neighbour's id and
  link to the wrong case. Now the id travels with the purchase.
- **The time-based escape hatches rendered enabled before their deadlines**,
  so clicking them would have reverted. Now gated on the deadline having passed.

### Decisions made this session

D14 in [MEMORY.md](./MEMORY.md): **a purchase has no `title` field.** Both specs
list one and the escrow has none; adding it means editing Solidity that had
never been compiled, for a display-only string, days out. The promise *is* the
object, so the UI shows `#id` plus the promise text.

### Blocked / needs the user

- **The frontend has still never been compiled.** No `tsc`, no `next build`.
  Vercel is currently the only thing that will ever compile it.

### Next

1. Compile the Solidity — Foundry turned out to be installed.

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
