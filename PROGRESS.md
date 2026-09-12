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
| Escrow tests | 🟢 **122/122 passing locally** (was 112 before the reconciliation tests) |
| GenLayer judgment contract | 🟢 **migrated to the v0.3.0 SDK surface — this was the schema error** |
| Judgment logic tests | 🟢 **passing locally** (11/11, re-run after the migration) |
| Cross-language hash vectors | 🟢 done and locked from both sides |
| Relayer | 🟢 written; **30/30 pure-logic tests passing locally**; SDK surface verified against the published package |
| Frontend (7 screens) | 🟢 **8 routes typecheck clean (`tsc --noEmit` exit 0) AND build (`next build` exit 0)** — verified locally 2026-09-11 |
| CI (GitHub Actions) | ⚠️ file written, **cannot push** — token lacks `workflow` scope |
| README / security narrative | 🟢 README, `docs/SECURITY.md`, `docs/DEPLOY.md` all written — every cross-link resolves |
| docs/MONEY_RAILS_AUDIT.md | 🟢 written — Issues 1–2 clean, Issue 3's gap closed by `totalHeld()`, Issue 4 still flagged unmeasured |
| GitHub push wired up | 🟢 working (code pushes fine; only `.github/workflows/` is blocked) |
| Vercel deploy | 🟡 **build-verified locally; not yet deployed** — see the Vercel readiness note below |
| GenLayer deploy (studio-dev 61997) | 🟢 **DEPLOYED — `0x0f385a4e7400a0693776D19102e0be75D334ce1c`, FINALIZED · MAJORITY_AGREE, 5/5 validators; schema loads** |
| Base escrow deploy | 🟢 **DEPLOYED — `0x32288128Ff07Fc9e443161c1F336b784508a056A`; all seven immutables verified on-chain** |
| Vercel deploy | 🟢 **READY — precondition met; one required env var, value known** |

Legend: 🔴 not started · 🟡 in progress · 🟢 done · ⚠️ blocked

> **The Solidity is now compiled and executed.** As of 2026-09-11 the escrow
> builds under solc 0.8.24 and all 122 Foundry tests pass — the first time any
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

## 2026-09-11 — Session 11

**The judgment contract is deployed on studio-dev.** This was the blocker the
whole build waited on — the Base escrow's `sourceContract` is immutable, so
nothing downstream could start without it.

```
RecourseJudgment   0x0f385a4e7400a0693776D19102e0be75D334ce1c
tx                 0x7cc0dbff9a96bb7266f0b261339f2b6224ca103eedbc4c107b0f9938d86e7c45
result             FINALIZED · MAJORITY_AGREE · 5 committed, 5 revealed
activator          0x6760cDeC573cf38568C59872ee48B6FED41F8A4c
```

The schema endpoint that used to return `Could not load contract schema` now
returns all four methods with correct signatures — `evaluate` (write),
`get_decision`, `has_decision`, `get_rounds` (views).

### Two independent faults, both fixed

**Fault 1 — the contract was on the v0.2.x SDK surface.** Covered in Session 10;
the migration was already done and is what made this deploy possible.

**Fault 2 — `--fee-value` alone is not a valid fee setup.** Even with the
contract fixed, the deploy reverted:

```
Transaction reverted: EVM tx 0x9221d5… FeeValueMustBeNonZero(1)
```

`--fee-value 10000000000000000` was passed and made no difference — the fee
*value* was never the constraint. The `--fee-value` flag alone builds a
**default** distribution (`rotations: [0]`, zero `executionBudgetPerRound`), and
the FeeManager rejects that. Confirmed by reading the transaction the CLI
simulated: it went to the consensus contract with `value: 0x0`.

**Fix:** `genlayer estimate-fees --json` returns a real distribution — notably
`rotations: ["3"]` and `executionBudgetPerRound: 25000000000000000` — plus a
matching `feeValue: 100000000000010352`. Passing both via `--fees` deployed on
the first try. Strip the `policy` block the estimate also returns; deploy does
not accept it.

### Corrections to earlier sessions — both were wrong

1. **Session 9 recorded that `estimate-fees` "cannot help" on studio-dev**
   because the RPC lacks `sim_getFeeConfig`. **That is false now** — it returns a
   full distribution and policy, and it is where the working values came from.
   Acting on that stale negative delayed this fix.
2. **Session 9's control — "a trivial contract with the same `Depends` header
   fails identically, so the contract is not the problem" — was invalid.** The
   control shared the exact defect under test (the v0.2.x header), so it proved
   a *shared cause*, not innocence. The contract **was** the problem. The lesson
   is recorded in `MEMORY.md`: **a control must differ from the suspect in the
   dimension under test.**

Also worth stating plainly: the `FINALIZED` + `NO_MAJORITY` + `votes_committed:
0` signature that Session 9 read as "studio-dev is not validating" is the
signature of a **transaction that could not pay its fee**. It is not a dead
network, and it had been masking the real fault for two sessions.

### CLI account alignment — three things, all silent when wrong

The user funded `0xe5Fe9119…a7b` (`.secrets/deployer.json`) on studio-dev. Three
separate misalignments had to be cleared, none of which names itself:

| Problem | Symptom | Fix |
|:--|:--|:--|
| CLI pointed at **studionet 61999** | `account show` reported **0 GEN for a funded account** | `genlayer network set studio-dev` |
| Active account was `default` (unfunded) | Deploy from the wrong key | `genlayer account use deployer` |
| Account `locked` | Cannot sign | `genlayer account unlock --account deployer --password …` |

`genlayer account show` prints address, balance, network, chainId and lock status
together, so it catches all three at once. **Run it before every deploy.**

### Done

- **Wrote `genlayer-studio-dev-deploy-issues.md`** — a standalone, self-contained
  troubleshooting playbook at the repo root, at the user's request. It documents
  both failures, the full rename table, the correct deploy sequence, the
  verification requirements, the dead ends that waste time, and the debugging
  method — written for someone with no context on this project, because the same
  two faults will hit any GenLayer project deploying to studio-dev.
- **Corrected `docs/DEPLOY.md`** — the whole "blocked by the network" section is
  superseded, and the stale `estimate-fees` claim is flagged as false in place
  rather than quietly deleted, so anyone holding the old belief sees the
  correction.
- Rewrote the deploy section around the two gates (account/network alignment,
  and the explicit fee distribution) with the working command.

### The Base escrow — deployed in the same session

With the judgment contract live, the escrow's `sourceContract` could finally be
filled in. Deployed to Base Sepolia:

```
RecourseEscrow   0x32288128Ff07Fc9e443161c1F336b784508a056A
tx               0xbf432879b02f14c61040e92dd821a595aacf901529a6a35afcada8a5b2744564
```

All **seven** immutables verified on-chain, not just the address:

| Field | Value |
|:--|:--|
| `sourceContract` | `0x0f385a4e7400a0693776D19102e0be75D334ce1c` |
| `sourceChainId` | `61997` |
| `relayer` | `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037` |
| `owner` | `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b` |
| `usdc` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `disputeBondBps` | `500` |
| `paused` | `false` |

**Three `forge create` traps, each of which cost an attempt:**

1. **Running it from the repo root.** `foundry.toml` is in `contracts/`, so from
   the root forge finds no config and compiles with the **optimizer off** —
   producing `Stack too deep`. The error points at the Solidity, so it reads like
   a contract regression. It is not; `forge build` from `contracts/` passes.
2. **`--broadcast` placed after `--constructor-args`.** That flag is variadic and
   swallowed `--broadcast` as a seventh argument →
   `Constructor argument count mismatch: expected 6 but got 7`. Without
   `--broadcast` at all, forge compiles, prints the ABI, and deploys nothing.
3. `sepolia.base.org` returned a transient TLS error (`BadRecordMac`) on one
   `cast call`; a retry cleared it. That is the RPC, not the contract.

**A standing risk this deploy creates.** `sourceContract` is immutable, so the
escrow is now permanently bound to `0x0f385a…` on chain 61997. **If studio-dev
resets, the judgment contract is gone and the escrow cannot be repointed** — a
reset means redeploying the escrow and re-seeding both env vars. Studio-dev is a
preview network and this is a known property of it. Check the GenLayer contract
still responds before a demo rather than assuming.

### Vercel — ready

The precondition ("do not deploy before the escrow exists") is now met. The
frontend needs **one** required variable and nothing else, because it reads the
verdict from Base and never from GenLayer:

| Variable | Value |
|:--|:--|
| `NEXT_PUBLIC_ESCROW_ADDRESS` | `0x32288128Ff07Fc9e443161c1F336b784508a056A` |

`NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` is optional. No GenLayer address, key or RPC
is needed on the frontend at all.

### Not done

- **The relayer has not been run against the live deployment.** Until it runs,
  the end-to-end path is unproven: nothing has actually carried a verdict from
  GenLayer to Base. The escrow is deployed and correct, but no money has moved.
  The next step is `DRY_RUN=true` against a real dispute.
- No demo data seeded — the frontend would render empty states until offers exist.
- Vercel itself is not deployed; only its configuration is known.

---

## 2026-09-11 — Session 10

The session that finally explained the `Could not load contract schema` error.
Session 9 called the studio-dev deploy "blocked by the network"; it was not. It
was **our contract being written against an SDK surface studio-dev does not
serve**, which is a repository bug and was fixable here.

### The finding: GenLayer has two incompatible SDK surfaces

The user supplied a contract that deploys fine through the studio-dev web
interface. Diffing it against ours isolated everything:

| | ours (and every public doc) | the working example |
|:--|:--|:--|
| header | `py-genlayer:1jb45aa8…` | `py-genlayer:5jycge4q…` |
| import | `from genlayer import *` | `import genlayer as gl` |
| base class | `gl.Contract` | `gl.contract.Contract` |

`1jb45aa8…` selects the **v0.2.x** runner; `5jycge4q…` selects **v0.3.0**.
studio-dev serves only the latter. So the contract's names never resolved, and
the Studio reported it as a *schema* failure — which reads like a syntax error
and sent several sessions looking for a malformed class declaration that was
never there. **The contract was never malformed; it was stale.**

The authoritative source is `sdk.genlayer.com/main/executors/v0.3/`.
`docs.genlayer.com` is stale and still documents the old surface, and so does
GenLayer's own Claude Code `write-contract` plugin. The full rename table is now
in `MEMORY.md`.

**☠️ The rename hides one real trap.** `gl.vm.run_nondet` **changed meaning**:
it used to be the *safe* variant and is now the *unsafe* one, with the safe one
moved to `run_nondet_default`. Old code calling it still compiles and still runs
— it just silently stops validating. The correct migration is the 1:1 pairing
`run_nondet_unsafe → run_nondet`, which is what `recourse_judgment.py` uses.
`__on_errored_message__` was removed outright.

### Done

- **Migrated `genlayer/contracts/recourse_judgment.py`** to v0.3.0, **name-only**.
  Every rename in the table applied; **no semantic change**. Deliberately *not*
  done: `run_nondet_unsafe → run_nondet_default`, which would have been a silent
  upgrade from unsafe to safe validation. Also added: `@gl.evm.contract_interface`
  is unchanged in v0.3.0, confirmed present in the SDK.
- **Rewrote `genlayer/contracts/gen_sender.py`** against v0.3.0.
- **Fixed the SDK stub in `genlayer/tests/test_judgment_logic.py`.** The contract
  now does `import genlayer as gl`, so `gl.contract` resolves to the *submodule*
  `genlayer.contract` — the stub had to attach names to the module object, not to
  a `gl` attribute. The stub deliberately does **not** provide the old flat names,
  so any drift back to v0.2.x fails the import loudly instead of passing quietly.
- **All 11 judgment-logic tests pass after the migration** — which is the
  evidence that the rename preserved behaviour rather than merely importing.
- **Rewrote `docs/GEN_SENDER.md`**, which had carried two actively wrong claims
  (that the contract should drop its `Depends` header, and that `u256` is
  unexported). Both were unjustified inferences from a stale doc page.

### The funding problem, and its real shape

A CLI deploy from the keystore account `0xa881365a…466d` ended `FINALIZED` /
`NO_MAJORITY` / `votes_committed: 0` / `activator: ''`. That is **not** a network
fault: studio-dev charges a GenLayer **consensus fee from a real GEN balance**
even though EVM gas is free (`eth_gasPrice` is `0x0`). An account with 0 GEN
cannot pay it, so no validator activates the tx — and the failure never says
"insufficient funds". That presentation is what made it look like a dead network
for two sessions.

**Fix:** the repo's deployer key (`.secrets/deployer.json`) was imported into the
CLI as the account **`deployer`**, and set active:

```
genlayer account import --name deployer --private-key 0x2d70…1a1d --password recourse-testnet-local
```

The derivation produced `0xe5fe9119000c9e1113dc504891a83da7bbaa7a7b`, matching
`.secrets/deployer.json` exactly — so the key is confirmed correct, and the
wallet the user faucets in a browser is now the same account the CLI spends from.
**Nothing else stood in the way.** Faucet that address on studio-dev and the
deploy works.

**Consequence: `GenSender` is off the critical path.** It was written because
`default` looked unfundable. With `deployer` active and faucetable directly, no
sender contract is needed. It stays in the repo as a working demo of the
IC → EOA `emit_transfer` pattern, and `docs/GEN_SENDER.md` now says so at the top
rather than presenting itself as the unblocker.

### Not done

- **Still no GenLayer contract address on studio-dev.** The blocker is now purely
  the faucet claim, which is a user action — the code side is finished.
- **The Base escrow deploy still waits on that address** (`sourceContract` is
  immutable), and Vercel env vars depend on the escrow address in turn.
- `genlayer-known-money-rails-issues.md` still shows its Issue 1 snippet in the
  old bare-`u256` v0.2 idiom. The *pattern* it documents is correct and `gen_sender.py`
  follows it; only the snippet's spelling is stale.

---

## 2026-09-11 — Session 9

Short session. Closed the one real gap the money-rails audit found, and kept the
documents honest about it.

### Done

- **Added `RecourseEscrow.totalHeld()`** — a view returning what the contract's
  own ledger says it is holding: the price of every `FUNDED`, `DELIVERED` or
  `DISPUTED` purchase, plus the bond of every `DISPUTED` one. Compare it against
  `usdc.balanceOf(escrow)` and a surplus means value arrived with no ledger
  entry. This is the reconciliation check the money-rails doc's checklist asks
  for, and it was the only gap that audit found in Recourse.
- **Added 10 tests for it** (`contracts/test/RecourseEscrow.t.sol`), 112 → **122
  passing**. They assert the two numbers agree at every stage: zero before
  anything happens, ignored while an offer is unpaid, counted once funded and
  still counted once delivered, bond added once disputed, zero again after both
  a release *and* a refund settlement, correct across a mixed-stage set, and
  unaffected by cancelled offers or deadline refunds. The assertions compare
  against the non-zero `PRICE` constant, so they cannot pass vacuously.
- **Measured the cost.** Runtime went 16,403 → **16,651 B**, still 7,925 B under
  the EIP-170 limit. The loop is `O(purchases)` and view-only, so it costs no
  gas to anyone — it is a read for a human or a monitor.
- **Updated every document that recorded the gap as open** —
  `docs/MONEY_RAILS_AUDIT.md` (both the Issue 3 section and the "what to do
  next" list), `docs/SECURITY.md` §7, `PROGRESS.md` and `MEMORY.md`. All four
  now say the same thing, including the half that is still true: **the view has
  no caller.** Nothing watches it on a live deployment, so the gap is closed for
  a person checking and still open for a machine watching.

### The GenLayer deploy — what actually happened

Session 8 left this "blocked by Bradbury". It was more than that, and this
session found four separate faults stacked on each other.

1. **The CLI was too old to target the required network.** The installed CLI was
   **0.37.1**, whose bundle contains **zero** occurrences of
   `studio-dev`/`studioDevnet`/`61997`. The migration doc says to use the CLI
   `studio-dev` alias *"supplied by the matching RC"* — the `rc` dist-tag is
   `0.40.0-rc.3`. Upgraded; it now knows the network and the fee flags.
   This was the real root cause, and nothing before it was diagnosable.
2. **studio-dev is fee-charging even though it is EVM-gasless.** `eth_gasPrice`
   is `0x0` and the account balance is `0` — the zero balance is *expected*, not
   a missing faucet. But an unfunded deploy reverts `FeeValueMustBeNonZero(1)`.
   `estimate-fees` cannot help: studio-dev's public RPC has no
   `sim_getFeeConfig` and no `gen_dbg_traceTransaction`. Passing a fee value and
   a distribution clears that error.
3. **studio-dev activates no validators.** With the fee error cleared, every
   attempt ends the same way: `status: FINALIZED`, `result_name: 'NO_MAJORITY'`,
   `num_of_rounds: '0'`, `votes_committed: '0'`, `activator: ''`,
   `last_leader: ''`. A 300-block scan found exactly **one** non-empty block —
   our own transaction. Raising the fee to 0.01 GEN changed nothing.
4. **Bradbury's block is arithmetic.** The stranded tx at nonce 284 bid
   0.17322855 gwei; replacing it needs a 10% bump (0.1906 gwei) and the network
   suggests only 0.1875 gwei. It misses by ~1.6%, and the CLI has no gas-price
   flag. Its RPC also load-balances across nodes with unsynchronised mempools.

**The control that makes this diagnosable:** the *identical* contract, with the
*identical* fee, deployed on **studionet** in this same session —
`MAJORITY_AGREE`, 5 validators, 5 votes revealed, a live activator, contract at
`0x3bb55747305282DBDbD6baC4215f4796b0Bc12C6`.

That address is on the wrong chain and does not satisfy the submission. It is
recorded here only as evidence: it proves the contract, its `Depends` header and
its fee path are all sound, and it isolates the studio-dev failure to the
network rather than to anything in this repository.

**The Base escrow is still not deployed**, and still cannot be — `sourceContract`
is immutable. No amount of work on the escrow side unblocks it.

### Not done

- The judgment contract is still undeployed **on studio-dev**, pending that
  network activating validators. This is the only thing standing between the
  repo and an end-to-end demo, and it is not fixable from this side.
- `docs/DEPLOY.md` §2 now leads with the CLI version check
  (`0.40.0-rc.3`, not `0.37.1`), the mandatory `--fee-value`, and the evidence
  that the studio-dev failure is network-side — including the studionet control
  address. Bradbury's arithmetic dead end is kept as a separate subsection so
  the two faults are not confused again.
- `docs/DEPLOY.md` §7 now carries the reconciliation read as a post-deploy
  check, with the note to run it *mid-dispute* — the state where the escrow
  holds both a price and a bond is the one where a leak would actually show.

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
- **Wrote `docs/SECURITY.md` and `docs/DEPLOY.md`** — both were linked from
  `MEMORY.md`, `DATA_MODEL.md` and the README and neither existed, so the
  submission had dead links pointing at its own security narrative. SECURITY.md
  carries the 16 settlement checks, the payout rule, the key blast-radius table
  and a "known gaps" section; DEPLOY.md is the ordered runbook, including the
  GenLayer blocker above so the next person does not re-diagnose it.
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
3. Add the escrow reconciliation check flagged in `docs/MONEY_RAILS_AUDIT.md` —
   the one real gap the security review surfaced.
4. Grant the `workflow` scope so CI can run (`gh auth refresh -s workflow`).

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
