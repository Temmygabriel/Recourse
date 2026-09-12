# MEMORY.md — Recourse

Durable project memory. Read this first when resuming work. It records
**decisions and constraints**, not a work log — for "what happened when", see
[PROGRESS.md](./PROGRESS.md).

Last updated: 2026-09-12 (Session 15 — the demo is seeded: **six purchases on Base
Sepolia, one in every stage**, and the seeder that put them there is
`relayer/scripts/seed-demo.ts`. It replaced a bash+`cast` script that silently
corrupted a rubric — see *Never build contract text by joining strings* below,
which is the one lesson from this session worth carrying forward. Session 14
fixed the frontend's two browser-facing defects, **neither yet exercised against
a real wallet**; the loop itself was closed in Session 13.)

---

## What this is

**Recourse** — escrowed payments on Base that become refundable when a delivery
does not match what was promised. GenLayer's validator network decides whether
the promise was kept; Base moves the money.

- Hackathon: **GenLayer Agent Tank**, Track 4 — **Onchain Justice**
- Build window: Sept 3–17, 2026. **Submission deadline Sept 17, 2026.**
- Prize: share of 5% of all GenLayer Points
- Must be **original** — README must differentiate from Internet Court
- Required: public GitHub repo, demo video, README with an honest security model

---

## Hard constraints

| Constraint | Detail |
|:--|:--|
| **Local machine** | 8 GB RAM, no significant compute. **Never run `npm install`, `next build`, or any other heavy *frontend* job locally** — those go to GitHub Actions or Vercel. **`forge build` and `forge test` are the exception:** the user amended the rule for Solidity on 2026-09-11, after Foundry turned out to be installed all along. Solidity has a compiler locally; the frontend does not. |
| **Local toolchain** | Node v24.14.0, npm 11.9.0, git 2.53.0. **Foundry 1.8.1 at `C:\Users\USER\.foundry\bin\forge.exe`** (also `cast`, `anvil`, `chisel`, `solar`, `foundryup`) — **not on `PATH`**; call by full path. **No `gh` on `PATH`** — it is installed at `C:\Users\USER\AppData\Local\gh-install\bin\gh.exe`; call it by full path or prepend that directory to `PATH`. **No `winget`.** No Vercel CLI, no SSH keys, no git credential store. |
| **Deployment** | Vercel, connected via the Vercel dashboard to the GitHub repo (not the CLI). Vercel runs install+build in its own cloud. |
| **Chain** | Base **Sepolia** testnet only. No mainnet, no real funds, ever, in this build. |
| **GenLayer** | Consensus **v0.6** / Studio **v0.123** release family. See below. |

---

## Decisions already made (do not relitigate without asking)

| # | Decision | Rationale |
|:--|:--|:--|
| D1 | **Escrow token = real Base Sepolia USDC** (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) | User's explicit choice. Requires faucet funds per demo run. |
| D2 | **Vercel deploys via dashboard repo-connect** | Zero compute on the 8 GB machine. |
| D3 | **Solidity has zero external dependencies** — no OpenZeppelin, no forge-std submodule for `src/` | `forge build` must work from a clean clone with no submodule fetch. |
| D4 | **Text lives on-chain as strings; hashes are derived by the contract** | The contract computes `sha256(bytes(text))` itself at write time, so the frontend never hashes and can never desync. Text is bounded (≤500 + 4×200 chars), so testnet gas is trivial. |
| D5 | **The contract owns the bond economics, not the UI** | Bond bps is set at deploy; bond math is on-chain. |
| D6 | **`UNDETERMINED` releases to the seller and returns the bond to the buyer** | Full reasoning in `docs/DATA_MODEL.md` §6. Short version: an inconclusive judgment does not establish a breach, and paying ambiguity the same as `FULL_REFUND` would make griefing free. |
| D7 | **An offer is a single-slot purchase record, not a stock item** | Matches the inspection-record metaphor. No marketplace browsing (explicitly out of scope). |
| D8 | **Wallet connect is `viem` + `window.ethereum` directly — no wagmi, no RainbowKit** | Keeps the frontend dependency tree tiny so Vercel builds are fast and a version-churn bug can't sink the demo. |
| D9 | **The relayer is a standalone Node process, not a Vercel function** | Vercel serverless can't hold the long-lived watcher GenLayer finality needs. |
| D10 | **`settle()` requires *both* `msg.sender == relayer` *and* a valid relayer signature** | Build spec §4.7 says only the relayer signature can call settlement; §4.1 says verify the relayer's message. Requiring both satisfies either reading and costs one comparison. A signature-only gate would make settlement permissionless — defensible as meta-transaction relaying, but it means a decision the relayer signed and then reconsidered can be pushed by anyone who saw it. Neither gate can change *what* a decision says, only whether it can be delivered. |
| D11 | **`src/` has zero Solidity dependencies; `forge-std` is installed by CI, not committed** | `contracts/lib/` is gitignored and the escrow imports nothing external, so a clean clone builds with no submodules. Only the test suite needs `forge-std`, so CI runs `forge install foundry-rs/forge-std --no-commit` before `forge test`. |
| D12 | **Every commitment hash is over verbatim bytes — no layer may trim, collapse, or normalise text before hashing** | The escrow reverts on over-length text rather than truncating so that `sha256(bytes(stored_text))` always describes exactly what the parties read and what GenLayer evaluates. The Solidity escrow and the GenLayer judgment contract are the only two implementations of these hashes, in different languages on different chains, and neither can detect that the other started stripping whitespace — the escrow would stay internally consistent while every relayed package failed its hash check, leaving real disputes permanently unjudgeable. `docs/vectors/hash-vectors.json` is the contract between them; `scripts/gen-hash-vectors.mjs` generates both that file and `contracts/test/HashVectors.generated.sol`, and CI regenerates and diffs them. |
| D13 | **The build targets Studio Devnet (chain 61997) only. Bradbury is for a contract deploy later, and nothing else depends on it yet.** | User's explicit instruction, 2026-09-10: *"let just focus on studiodev or what ever it called due to migration, we would only be deploying the contract on bradbury, the main build would be on studiodev."* So `GENLAYER_CHAIN` defaults to `studioDevnet` and the relayer's `assertChainMatchesEscrow` compares against 61997. Do not add Bradbury/Asimov fallbacks, dual-chain config, or chain-switching logic — a second target is surface area with no current consumer. The one caveat worth remembering: Studio Devnet may reset, which is why the escrow keeps `sourceChainId` immutable, so a later move to Bradbury is a redeploy rather than a rewrite. |
| D14 | **A purchase has no `title` field. Its identity is its id and the seller's promise text.** | Both specs list a title (build spec §2, design spec §5.1) and the escrow has no such field — `createOffer(price, deliveryDeadline, reviewWindow, promiseText, rubric)` is the whole write surface, and `Purchase` runs `promiseText, rubric[], deliveryNotes, disputeNotes`. Adding one means editing Solidity whose tests cannot be run, to add a display-only string, seven days out. The offer list and every header therefore show `#id` plus the promise itself, which is also more consistent with the product's thesis that the promise *is* the object. **Revisit now that `forge test` runs locally** — the original objection (unverifiable Solidity edit) is gone; the two files to update are `frontend/src/lib/abi.ts` (`purchaseComponents`, positional) and the relayer's `Purchase` interface. |
| D15 | **`via_ir` stays off. Stack-depth errors are fixed by reducing live locals.** | Both `Stack too deep` errors (in `settle` and `_hashDecision`) were fixed structurally — a `Payout` memory struct and a `_structHash` helper — rather than by enabling the IR pipeline. `via_ir` costs several times the compile time on a machine with no compute to spare, and it would have to be mirrored into CI. The structural fixes are also better code. |
| D16 | **`contracts/foundry.lock` is gitignored; CI pins `forge-std@v1.16.2` in the workflow instead.** | Forge writes the lockfile's dependency key with the **host's path separator** — a Windows-generated lockfile says `"lib\\forge-std"`, a Linux one says `"lib/forge-std"`. Committing it puts a platform-specific file in a repo whose CI runs on Linux, and every CI run rewrites it. Pinning the tag buys the same reproducibility without the churn. |
| D17 | **`genlayerKey()` renders the escrow address lowercase, and lowercase is authoritative.** | Not a free choice — it is what the contract's own hex encoder emits. What makes it safe is that **neither consumer rebuilds the string**: `relayer/src/escrow.ts` and `frontend/src/lib/escrow.ts` both call the view function and pass the result through, so only one rendering exists. `docs/DATA_MODEL.md` §8 now states the casing explicitly; it had been silent, which is what let a test drift onto EIP-55 checksummed and fail. |
| D18 | **In Foundry tests, never leave an external call inside the argument list of the call you are arming `vm.prank`/`vm.expectRevert` for.** Compute the signature into a local on the line above. | Solidity evaluates arguments before the call, and a pending `vm.prank` or `vm.expectRevert` is consumed by the **next call of any kind — a `view` function included**. So `escrow.settle(d, _sig(d))`, where `_sig` calls `escrow.hashDecision`, spends the prank on `hashDecision`: `settle` then runs as the test contract and reverts `"not relayer"`, and the expectRevert is spent on a call that did *not* revert, so the test fails with "next call did not revert as expected". Both symptoms are one bug and **neither points at the contract** — this cost 37 red tests on 2026-09-11 that were all the harness's fault. The file was fixed by hoisting; keep the convention when adding tests. |
| D19 | **Wallet selection is EIP-6963 discovery, and with more than one wallet the app asks — it never falls back to `window.ethereum`** | `window.ethereum` is a single property, so with two wallets installed it holds whichever extension loaded last, which has nothing to do with which one the user is looking at. Using it connects people to a wallet they are not looking at. EIP-6963 gives one provider per wallet, the choice is remembered by `rdns` (stable, unlike the per-load `uuid`), and `window.ethereum` is consulted **only** when discovery finds nothing — which means a browser with one pre-6963 wallet in it. Extends D8: still no wagmi, no RainbowKit; the discovery is ~90 lines in `frontend/src/lib/eip6963.ts`. |
| D20 | **`connect()` asks for an account and nothing else. The network is switched at the write, or by an explicit button.** | Connecting used to switch chains immediately, which on a wallet that has never seen Base Sepolia is an *add-network* dialog — and wallets treat adding a chain as a security decision, so the user's first click produced a "you could lose funds" warning on a screen that never explained why. The dialog is accurate; the moment was wrong. Raising it at the write means the user is already signing something and the prompt is self-explanatory. **Do not "simplify" this back into `connect()`.** |

---

## The relayer is a trust boundary — never claim otherwise

This is the single most important thing to get right in the README and demo.

Base **cannot** verify GenLayer finality from inside an EVM contract. The
`SettlementDecision.finalized` field is an assertion by the relayer. Everything
else in the decision *is* verified on-chain (see `docs/SECURITY.md`), but
`finalized` is not.

**Required wording:** "the relayer is a trusted prototype component; this is
testnet-only." Do **not** describe the system as trustless. The build spec is
explicit that overclaiming here is the failure mode to avoid.

---

## GenLayer Consensus v0.6 — the parts that change our code

Source: https://docs.genlayer.com/developers/consensus-v06-migration

| Item | Rule |
|:--|:--|
| Version family | Consensus v0.6 RC + Studio v0.123 RC + `genlayer-js` v2.0 RC + CLI v0.40 RC. **Install one coherent RC set; pin exact versions.** Prerelease tags must be requested explicitly — `latest` will *not* resolve to the RC. |
| Preview network | **studio-dev** — RPC `https://studio-dev.genlayer.com/api`, chain ID **61997**. Separate from stable Studionet (**61999**). |
| Network selection | Use `studioDevnet` / `studio-dev` for the preview. **Never** point the stable `studionet` chain object at the preview RPC — chain identity and consensus contract addresses move together. |
| Fees | Every deploy and write on a fee-charging deployment must carry a `FeesDistribution` and its quoted fee value. Build a `fee-profile.json` with `gltest --fee-profile`, convert a profile entry into live estimate options, read current prices/caps through the SDK estimate, then submit the returned `distribution` and `feeValue` **unchanged**. A Studio deployment can be gasless — detect that from the estimate result, **not** from the network name. |
| Appeals | Use `client.getAppealCharge({txId})` then `client.appealTransaction({txId, value: charge})`. Direct `submitAppeal` can revert with `AppealRoundNotPermitted`. Successful appeal pays 2.5× bond total (principal + 1.5× profit). |
| Success test | A tx is successful **only** if status is `ACCEPTED`/`FINALIZED` **and** execution result is `FINISHED_WITH_RETURN`. Use the SDK `isSuccessful` helper. Status alone is not success. |
| Appeal rounds | Verified escalation is **5 → 11 → 23** validators. Never hardcode a smaller sequence, never assume a fixed appeal duration — read it from protocol state. |
| Storage | Studio-dev may reset. Bradbury is the durable target only once v0.6 is promoted there. |

### Deploying to studio-dev — the two gates, both now proven

**✅ RecourseJudgment is live: `0x0f385a4e7400a0693776D19102e0be75D334ce1c`**
(tx `0x7cc0dbff…7c45`, `FINALIZED` · `MAJORITY_AGREE`, 5/5 votes revealed,
activator `0x6760cDeC573cf38568C59872ee48B6FED41F8A4c`). Reached 2026-09-11 after
two independent faults were fixed. Full runbook in `docs/DEPLOY.md`.

**Gate 1 — the CLI must be pointed at the right account AND the right network.**
Three things that fail silently and separately:

| Check | Command | Note |
|:--|:--|:--|
| Network | `genlayer network set studio-dev` | The CLI defaults to **studionet 61999**. `account show` against the wrong network reports a **0 GEN balance for a funded account** — that is a network mismatch, not an empty wallet. |
| Active account | `genlayer account use deployer` | `default` and `deployer` both exist; only `deployer` (`0xe5Fe9119…a7b`) is funded. |
| Unlocked | `genlayer account unlock --account deployer --password …` | Deploy needs the key in the OS keychain. |

`genlayer account show` prints address, balance, network, chainId and lock status
together — **run it before every deploy.** It catches all three at once.

**Gate 2 — `--fee-value` alone is NOT a valid fee setup.**
It builds a *default* distribution (`rotations: [0]`, zero
`executionBudgetPerRound`), and the FeeManager rejects that with
**`FeeValueMustBeNonZero(1)`** (selector `0x632be5a1`). The name is misleading:
the fee *value* was never the problem and raising it changes nothing — the
**distribution** was.

```bash
genlayer estimate-fees --json     # returns {distribution, feeValue, policy}
genlayer deploy --contract <path> --fees "$(cat fees.json)"
```

Pass the returned `distribution` and `feeValue` **unchanged**, and **strip the
`policy` block** — `estimate-fees` returns it but deploy does not accept it. The
working distribution is not all-zeros: it carries `rotations: ["3"]` and a real
`executionBudgetPerRound` (`25000000000000000` in our run) with
`feeValue: "100000000000010352"` (~0.0001 GEN against a 20 GEN balance).

> **Correction:** an earlier session recorded that `estimate-fees` *"cannot help"*
> because studio-dev's RPC lacks `sim_getFeeConfig`. **That is false as of
> 2026-09-11** — the command returns a full distribution and policy. Do not
> reason from that older note.

**Read the revert before choosing a fix — the two errors mean opposite things:**

| Revert | Meaning | Fix |
|:--|:--|:--|
| `FeeValueMustBeNonZero(1)` | The **distribution** is default/empty | Pass a real estimate (above) |
| execution / out-of-budget | The distribution is fine but **`executionBudgetPerRound` is too low for this contract** | Raise `executionBudgetPerRound` *and* `feeValue` together |

### ⚠️ GenLayer has TWO incompatible SDK surfaces, and studio-dev only serves v0.3.0

**This was the root cause of every `Could not load contract schema` failure.**
The contract was not malformed — it was written against a surface the network
does not serve. Nothing in the public docs says this clearly, which is why it
cost several sessions.

| | **v0.2.x** — these docs, and every GenLayer doc page | **v0.3.0** — what studio-dev actually runs |
|:--|:--|:--|
| `Depends` header | `py-genlayer:1jb45aa8…` | `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` |
| import | `from genlayer import *` | `import genlayer as gl` |
| base class | `gl.Contract` | `gl.contract.Contract` |
| IC interface | `@gl.contract_interface` | `@gl.contract.interface` |
| get existing IC | `gl.get_contract_at(a)` | `gl.contract.get_at(a)` |
| deploy from IC | `gl.deploy_contract(…)` | `gl.contract.deploy(…)` |
| proxy | `gl.ContractProxy` | `gl.contract.Proxy` |
| events | `gl.Event` | `gl.chain.Event` |
| storage types | `gl.DynArray` / `gl.Array` / `gl.TreeMap` | `gl.storage.DynArray` / `gl.storage.Array` / `gl.storage.TreeMap` |
| storage opt-in | `gl.storage.allow_storage` | `gl.storage.allow` |
| raw message | `gl.message_raw` | `gl.message.raw` |
| user error | `gl.advanced.user_error_immediate(…)` | `gl.vm.UserError.immediate(…)` |
| user error payload | `UserError(msg).message` | `UserError(data).data` |
| raw event | `gl.advanced.emit_raw_event(…)` | `gl.chain.Event.emit_raw(…)` |
| tracing | `gl.trace(…)` / `gl.trace_time_micro()` | `gl.vm.trace(…)` / `gl.vm.trace_time_micro()` |
| **nondet, unsafe** | `gl.vm.run_nondet_unsafe(fn, val)` | **`gl.vm.run_nondet(fn, val)`** |
| **nondet, safe** | `gl.vm.run_nondet(fn, val)` | **`gl.vm.run_nondet_default(fn, val)`** |

**☠️ THE TRAP — `gl.vm.run_nondet` silently changed meaning.** In v0.2.x it was
the *safe*, sandboxed-validator variant. In v0.3.0 that name belongs to the
*unsafe* variant, and the safe one moved to `run_nondet_default`. Old code that
calls `gl.vm.run_nondet` still compiles and still runs — it just quietly stops
validating. Always migrate `run_nondet_unsafe → run_nondet` (a true 1:1 rename);
never `run_nondet → run_nondet_default` reflexively. **`recourse_judgment.py`
uses `gl.vm.run_nondet` deliberately, preserving its original unsafe semantics.**

**Also: `__on_errored_message__` was removed in v0.3.0.** Do not reintroduce it.

**Not renamed** — `@gl.evm.contract_interface` is unchanged, and so are
`@gl.public.view`, `@gl.public.write`, `@gl.public.write.payable`,
`gl.nondet.exec_prompt`, `gl.vm.Return` (`.calldata`), `gl.vm.Result`,
`gl.vm.UserError`.

**`import genlayer as gl` binds `gl` to the PACKAGE**, so `gl.contract`, `gl.vm`,
`gl.storage`, `gl.nondet`, `gl.evm`, `gl.message` are top-level *submodules* of
`genlayer` — not attributes nested under some `gl` object. `gl.Address`,
`gl.u256`, `gl.u32` are package-level type aliases.

**Where the truth lives:** `sdk.genlayer.com/main/executors/v0.3/` is
authoritative. `docs.genlayer.com` is **stale** — its pages still show the
left-hand column, which is what makes this trap so easy to walk into. GenLayer's
own `write-contract` Claude Code plugin is *also* on the stale surface.

**Both contracts are migrated as of 2026-09-11** (`gen_sender.py`,
`recourse_judgment.py`) and the 11 judgment-logic tests still pass, which is the
evidence that the rename preserved behaviour.

### genlayer-js 2.0.0-rc.1 — the surface, read out of the published package

Verified 2026-09-10 by downloading the tarball and inspecting `dist/`. This is not recalled from the docs, and it **contradicts** them in two places. The package is 185 KB / 27 files; `npm pack genlayer-js@2.0.0-rc.1` needs no install.

| Item | Fact |
|:--|:--|
| Exists? | **Yes** — `genlayer-js@2.0.0-rc.1` is published. Confirmed via `npm install --package-lock-only`, which resolves it and also pins `viem@2.56.3`. |
| Entry points | `genlayer-js` (index), `genlayer-js/chains`, `genlayer-js/types`. All ESM (`"type": "module"`), with a CJS fallback build. |
| Chain exports | `localnet`, `studioDevnet`, `studionet`, `testnetAsimov`, `testnetBradbury`. **There is no `studio-dev` or `studiodev` export** — the migration doc's spelling is wrong. |
| Chain ids | `localnet` 61127, `studioDevnet` **61997**, `studionet` **61999**, `testnetAsimov` **4221**, `testnetBradbury` **4221**. |
| ⚠️ Id collision | **Asimov and Bradbury both declare `id: 4221`.** Resolving that number by id is a coin flip between two networks. Always name the chain. |
| RPCs | studioDevnet `https://studio-dev.genlayer.com/api` · studionet `https://studio.genlayer.com/api` · Bradbury `https://rpc-bradbury.genlayer.com` · Asimov `https://rpc-asimov.genlayer.com`. Bradley's `blockExplorers` is explicitly `undefined` — the stable Studio explorer does not index it. |
| Top-level values | `createClient`, `createAccount`, `generatePrivateKey`, `isSuccessful`, `abi`, `chains`, `calldata`, `transactions`, `normalizeTransactionFees`, `createFeesDistribution`, `DEFAULT_FEES_DISTRIBUTION`, `decodeTransaction`, `simplifyTransactionReceipt`. |
| ⚠️ Enums are NOT on the main entry | `TransactionStatus`, `ExecutionResult`, `TransactionResult`, `TransactionHashVariant` are **runtime values only from `genlayer-js/types`**. The `.d.ts` of the main entry appears to export some of them, but the compiled `index.js` does not — importing them from `genlayer-js` typechecks and then yields `undefined`. Use `genlayer-js/types`, or string literals. |
| Client methods (verified) | `readContract`, `writeContract`, `simulateWriteContract`, `deployContract`, `getTransaction`, `waitForTransactionReceipt({hash, waitUntil: 'decided'\|'finalized'})`, `waitForDecision`, `waitForFinalization`, `getContractSchema`, `getContractCode`, `canAppeal`, `getAppealCharge`, `appealTransaction`, `topUpFees`, `topUpAndSubmitAppeal`, `getRoundNumber`, `getRoundData`, `getLastRoundData`, `estimateTransactionFees`, `estimateTransactionFeesForWrite`, `estimateFeesDistribution`, `estimateTransactionFeesFromSimulation`, `getCurrentFeePolicy`, `getCurrentNonce`, `transfer`, `advanced.getTransactionLifecycle`. |
| Deprecated but present | `initializeConsensusSmartContract`, `getMinAppealBond` (alias of `getAppealCharge`), `waitForTransactionReceipt({status})`. |
| ⚠️ Wait calls have a **30-second ceiling by default** | `waitForFinalization` and `waitForTransactionReceipt` both default to `waitInterval: 3000` and `retries: 10` — ten 3-second sleeps, then a hard throw. That is a **30-second** timeout on a wait that takes minutes on studio-dev, and it cost a live run (Session 13). **Always pass `interval` and `retries` explicitly.** The relayer now uses 5 s × 240 = 20 min. The SDK's own error names the status it gave up at (`current status: 5`), and **status 5 is `ACCEPTED`, not a failure** — the tx may still finalize. |
| Value literals | `ExecutionResult.FINISHED_WITH_RETURN = "FINISHED_WITH_RETURN"`, `TransactionStatus.FINALIZED = "FINALIZED"`, `TransactionHashVariant.LATEST_FINAL = "latest-final"`. |
| Consequence for us | The relayer loads the SDK dynamically and duck-types every call, so an RC rename becomes a precise runtime error instead of a resolution failure. That choice is now known-correct: no code change was needed for the surface above beyond fixing the chain-name resolution. |

---

## Key addresses and paths

### Testnet keys — in `.secrets/`, gitignored, testnet only

| Role | Address | File |
|:--|:--|:--|
| Deployer | `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b` | `.secrets/deployer.json` |
| Relayer signer | `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037` | `.secrets/relayer.json` |
| Demo (browser) | `0x0DE10708F8c6DF7b73068d53def715A70C0f340D` | `.secrets/demo.json` |

### The GenLayer CLI's own accounts — two of them, and the active one is what matters

The CLI keeps its own keystores in **`C:\Users\USER\.genlayer\keystores\`**, which
is *outside this repo*. `genlayer account list` shows them; the **`*` marks the
active one, and the active one is the account that pays for and signs every
deploy.**

| CLI name | Address | Notes |
|:--|:--|:--|
| `default` | `0xa881365a99d77be904e414ae610e22938bb0466d` | The original keystore. Encrypted, **password not recorded anywhere**. Never successfully funded. |
| **`deployer`** | `0xe5fe9119000c9e1113dc504891a83da7bbaa7a7b` | **Imported 2026-09-11 from `.secrets/deployer.json`, and now active.** Same key as the repo deployer, so the MetaMask wallet the user faucets and the account the CLI spends from are one and the same. Keystore password `recourse-testnet-local`. |

**Why this mattered:** a deploy run from `default` ended
`NO_MAJORITY` / `votes_committed: 0` / `activator: ''` on studio-dev, because
studio-dev charges a GenLayer consensus fee from a **real GEN balance** even
though EVM gas is free (`eth_gasPrice` is `0x0`). An unfunded account cannot pay
that fee, so no validator ever activates the transaction. The error surfaces as a
silent non-activation, **not** as insufficient funds — which is what made it
look like a network fault for several sessions.

**Unify on the deployer account.** Do not faucet `0xa881…466d` and expect the
CLI to spend it while `deployer` is active — or vice versa. `genlayer account
use <name>` switches, and `genlayer account show` prints the address and balance
of whichever is active.

> `docs/GEN_SENDER.md` describes a payable contract for forwarding GEN to an
> address you name. It was written when `default` was active and appeared
> unfundable. **With `deployer` active and faucetable directly, GenSender is no
> longer on the critical path** — keep it as a demo of IC→EOA value transfer, but
> do not treat it as the deploy unblocker.


The relayer address must be passed to the escrow constructor. Regenerate the
deployer/relayer pair with `node scripts/gen-wallet.mjs --out .secrets`, or add
one more independent key with `--out .secrets --wallet <name>`. Both refuse to
overwrite existing files — including the `--wallet` form, which is why adding a
wallet can never clobber the two the escrow and the relayer depend on.

The demo wallet is the MetaMask account the browser signs with. **Its private
key is deliberately not printed anywhere** — it is in `.secrets/demo.json`,
which is gitignored and written mode 0600. Read it from the file to import into
a wallet; do not paste it into a terminal or a transcript.

> The key generator (`scripts/gen-wallet.mjs`) implements Keccak-256 and
> secp256k1 address derivation from scratch on top of Node builtins. Its
> correctness is pinned by published test vectors — **run
> `node scripts/gen-wallet.mjs --self-test` before trusting any address it
> prints.** A transposed rotation table in the Keccak permutation still
> produces a plausible-looking address; it is simply the wrong one.

### Base Sepolia balances — verified on-chain 2026-09-11

Checked with `cast balance` / `balanceOf` against two independent RPCs (they
agreed). Recorded because an earlier session carried "needs faucet funds" as a
blocker **without ever looking**, and it was wrong:

| Address | ETH | USDC |
|:--|:--|:--|
| Deployer | 0.02 | 20.00 |
| Relayer | 0.001 | 20.00 |
| Demo | 0.01 | 20.00 |

Two things worth not re-deriving:

- **The relayer does not need USDC.** It only ever calls `settle()`, which moves
  money the escrow already holds and costs nothing but gas. The 20 USDC the user
  put there is harmless but not used by any code path; if a later step seems to
  want it, that is a sign the relayer is being asked to do something it should
  not be doing.
- **0.001 ETH is not a small number here.** Base Sepolia gas is cheap enough
  that this is hundreds of `settle()` transactions. Gas is not the binding
  constraint on this build; USDC and time are.

All three wallets are now funded, so **no faucet request is outstanding.** The
demo wallet's 0.01 ETH is its gas ceiling: it is the wallet a human clicks
through the demo with, so a rehearsal that runs long can drain it. If a demo run
starts failing on gas, that is the wallet to top up, not the deployer.


### Known non-secret addresses

| Thing | Address |
|:--|:--|
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| **RecourseEscrow (Base Sepolia)** | **`0x32288128Ff07Fc9e443161c1F336b784508a056A`** — deployed 2026-09-11, all seven immutables verified |
| **GenLayer judgment contract (studio-dev 61997)** | **`0x0f385a4e7400a0693776D19102e0be75D334ce1c`** — deployed 2026-09-11, `FINALIZED` · `MAJORITY_AGREE` |
| GenLayer judgment contract (studionet 61999) | `0x3bb55747305282DBDbD6baC4215f4796b0Bc12C6` — **wrong chain for the submission**, kept only as evidence that studionet serves the *v0.2.x* runner |

### The two are bound together and cannot be re-paired

The escrow's `sourceContract` (the GenLayer address) and `sourceChainId` (61997)
are **immutable**. Verified on-chain after deploy alongside `relayer`, `owner`,
`usdc`, `disputeBondBps` (500) and `paused` (false).

**Consequence — the load-bearing risk:** if **studio-dev resets**, the judgment
contract at `0x0f385a…` is gone, and the escrow **cannot be repointed**. A reset
means redeploying the escrow too, and then re-seeding every env var that carries
the escrow address (`NEXT_PUBLIC_ESCROW_ADDRESS`, `ESCROW_ADDRESS`). Studio-dev
is a preview network and this is a known property of it, not a surprise — but it
is the single event that would invalidate the whole deployed stack, so check the
GenLayer contract still responds before a demo rather than assuming.

**Env wiring:**

| Consumer | Variable | Value |
|:--|:--|:--|
| Frontend (Vercel) | `NEXT_PUBLIC_ESCROW_ADDRESS` | `0x32288128Ff07Fc9e443161c1F336b784508a056A` |
| Relayer | `ESCROW_ADDRESS` | `0x32288128Ff07Fc9e443161c1F336b784508a056A` |
| Relayer | `GENLAYER_CONTRACT_ADDRESS` | `0x0f385a4e7400a0693776D19102e0be75D334ce1c` |
| Relayer | `GENLAYER_CHAIN` | `studioDevnet` |
| Relayer | `RELAYER_PRIVATE_KEY_FILE` | `../.secrets/relayer.key` |

---

### The loop is proven — purchase 1, settled 2026-09-12

The first complete run of the system, end to end, with real money. Kept here
because it is the **reference case**: any future settlement can be checked
against these numbers.

| | |
|:--|:--|
| Purchase | id **1** (remember `nextPurchaseId` starts at **1**, so id 0 is a permanently empty slot and `purchaseCount()` is not the latest id) |
| Seller / buyer | `0xe5Fe9119…a7a7b` / `0x0DE10708…f340D` |
| Price / bond | 5.00 USDC / 0.25 USDC (500 bps) |
| Verdict | `PARTIAL_REFUND`, `refund_bps` **3333**, `criteria_met` `[true,true,false]` |
| GenLayer tx | `0xcdf78c54…` — FINALIZED · Accepted |
| Base `settle()` tx | `0xc77820a0…` — block 46721614, gas 188,764, status 1 |
| Paid out | buyer **1,916,500** (refund 1,666,500 + bond 250,000); seller **3,333,500** |
| Decision digest | `0x48edbbba…` |

**The invariant that makes this checkable:** `refund + bond = 1,916,500` and
`seller = price − refund`, summing to exactly `price + bond = 5,250,000`. The
escrow ends at **0 USDC** with `totalHeld() == 0`. If a future run settles with
more or less than `price + bond` leaving the contract, something is wrong.

**`DRY_RUN=true` in `relayer/.env` signs and simulates but never broadcasts.**
It was used for the first live pass and then flipped to `false` for the real
settlement. Note `dryRun` also forces `onceOnly` (`src/index.ts`), so a
DRY_RUN invocation exits after one tick and cannot retry a timed-out finality
in the same process — re-run it instead. State persists in
`relayer/.relayer-state.json`, so a re-run resumes rather than re-spending the
GenLayer fee.

### ⚠️ Base Sepolia's public RPC has lagging replicas, and it bites twice

`https://sepolia.base.org` load-balances across nodes that **do not agree on
recent state**. Two distinct symptoms, both observed live in Session 13, and
both are *not* contract bugs:

1. **Spurious pre-broadcast reverts.** `eth_estimateGas` — which viem calls
   before every write — can run against a replica that has not yet seen a
   transaction that already landed. Observed as `openDispute` failing
   `transferFrom failed` immediately after a successful `approve`, with the
   allowance verifiably correct on-chain. Re-simulating the identical call
   returned `0x` (success).
2. **Stale reads.** `getPurchase` and `purchaseCount` can return
   pre-transaction state right after a write succeeds. Observed as `inspect()`
   printing `DELIVERED`/bond 0 immediately after `openDispute` had mined.

**How the code handles it:** the E2E driver retries pre-broadcast failures but
never a mined revert (`MinedRevert` is terminal — a revert is a real answer),
and `waitForStage()` polls instead of reading once. The relayer retries on its
next tick. **The frontend now handles it too** (Session 14): every write names
what it just made true and `frontend/src/lib/settle.ts` re-reads on a short loop
until the chain agrees, with the page showing an explicit "waiting for this page
to catch up" state and, on timeout, saying so rather than asserting either
outcome. See *The frontend waits for the chain after every write* below.

---

## The frontend waits for the chain after every write

`frontend/src/lib/settle.ts` + `useAsync().reloadUntil`.

The receipt proves a transaction was *mined*, not that the node answering the
next `eth_call` has seen it. So after each write the page names the state it
just created — `stageIs<Purchase>(STAGE.FUNDED)`, `…(STAGE.SETTLED)`,
`…(STAGE.DISPUTED)` — and re-reads on a 2s loop for up to 60s until the chain
agrees. Two screens (`deliver`, `dispute`) also wait before navigating, because
the page they land on reads once on mount.

**The predicate is always passed at the call site, never inferred.** A wrong
guess would silently accept the very stale state this exists to catch, and it
would typecheck and resolve either way — so the call site is the only place
that knows what it asked the chain to do.

If the wait times out the page says so honestly (`SETTLE_TIMEOUT_NOTE`): the
transaction *did* confirm, so reporting failure would be wrong, and reporting
success would be a guess. `settling` is deliberately distinct from `loading` —
"there is plenty to show, but it is about to change and must not be acted on".

---

## The wallet surface — the trap that comes with two installed wallets

`frontend/src/lib/eip6963.ts`, `wallet.tsx`, `components/WalletPicker.tsx`.

**The failure this exists to prevent:** every wallet used to inject at
`window.ethereum`, so with MetaMask and Brave Wallet both installed only one
wins — the last extension to load. The app then asks the *wrong wallet* for an
account, and the two disagree about address, balance and network for the whole
session. Some pairs throw straight out of `eth_requestAccounts` with *"Already
processing eth_requestAccounts"* — one wallet still holding the request the
other is making. The user reported this from Brave.

**The fix:** EIP-6963. Each wallet announces `{info, provider}` on
`eip6963:announceProvider`; nothing is overwritten and both providers are
usable. Announcements are only sent once on load — long before a Next.js page
hydrates — so the app **dispatches `eip6963:requestProvider`** to make them
re-announce, then collects for 250ms. Discovery finds; it does not choose.

**Rules that must not be undone:**

- One wallet → used silently. Several → **ask**, once, and remember by `rdns`.
- `window.ethereum` is consulted **only** when discovery found nothing.
  Binding it while a choice is pending would read an account out of a wallet
  the user never picked — the original bug, reintroduced.
- `rememberProvider(null)` means "deliberately none", which is *not* the same
  as "not decided yet" — hence the separate `selectionMade` flag in `chain.ts`.
- The picker is persisted in `localStorage` because connections are not. Without
  it the picker would reappear on every reload, which is worse than no picker.

**MetaMask's "you could lose funds" dialog** was caused by `connect()` switching
networks. On a wallet that has never seen Base Sepolia that is an *add-chain*
prompt, and wallets warn hard about it because an unrecognised RPC endpoint can
lie about balances and rewrite transactions. Two causes, both fixed:

1. The switch moved to the write path (+ an explicit header button), so the
   prompt now arrives when the user is already signing something.
2. `wallet_addEthereumChain` was being handed
   `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` — which may be a **private keyed
   endpoint**. That publishes a credential to a third party that stores and
   reuses it, *and* gives the wallet an endpoint it cannot match to chain id
   84532, which is itself a trigger for the warning. **The wallet always gets
   `CANONICAL_BASE_SEPOLIA_RPC` (`https://sepolia.base.org`) now.** Our own
   reads are unaffected.

Also fixed in the same pass, same class of mistake — the UI asserting what it
never checked: `chainOk` started `true` and was never probed (now set from
`eth_chainId`); "Wrong network — reconnect" told users to do the one thing that
cannot change a network (now a banner naming the chain, with a switch button);
and a declined switch (4001) was reported as "could not switch", hiding the one
fact that matters.

---

## The frontend reads the verdict from Base, never from GenLayer

Every number on the case, verdict and receipt screens — the outcome, the
per-requirement met/not-met marks, the seller/buyer split, the bond movement —
comes from the escrow's `Settled` event. **The browser never loads the GenLayer
SDK.** Three reasons, all of which matter more than the small saving in bundle
size:

1. Base is the chain that *moved the money*, so it is the right authority for
   "what was settled". GenLayer's answer is an input to that; the escrow's
   record is the result.
2. The three screens cannot disagree, because they read one event through one
   function (`fetchSettlement` in `frontend/src/lib/escrow.ts`).
3. It keeps a second RPC endpoint, a second chain config and a set of keys out
   of a client bundle that a judge will open in a browser.

The consequence to remember when extending the UI: if a fact is not in the
`Settled` event, the frontend does not have it. The GenLayer reason text, the
appeal state and anything else protocol-side are deliberately not surfaced.
`Settled` carries `purchaseId, outcome, refundBps, criteriaMetBitmap,
buyerAmount, sellerAmount, bondToBuyer, bondToSeller, nonce, genlayerTxHash,
decisionDigest` — and the **three non-judgment paths** (`acceptDelivery`,
`claimReviewTimeout`, `claimDeadlineRefund`) also emit `Settled`, with a zero
`genlayerTxHash` and zero nonce, because no judgment was involved. The UI says
so in words rather than printing a row of zeroes.

There is also **one delivery-evidence text and one dispute-evidence text** per
purchase, not one per criterion. The judgment contract receives the buyer's
disputed *indices* alongside those two blobs. So the comparison screen
(`frontend/src/components/PromiseVsEvidence.tsx`) shows the requirement list as
the spine with the disputed/found marks on it, and the two texts whole. It
deliberately does **not** split them per criterion — that split does not exist in
the data, and inventing one would be the single most misleading thing this UI
could do.

---

## ⚠️ Never build contract text by joining strings — `cast`'s `[a,b,c]` splits on every comma

Found the hard way in Session 14, seeding the demo, and it corrupted real data
on a live chain before anyone noticed.

`cast` accepts array arguments as `[a,b,c]`, and it splits that on **every
comma — including commas inside the quoted text**. So:

```
cast send $ESCROW 'createOffer(uint96,uint64,uint64,string,string[])' \
  1500000 172800 172800 "$PROMISE" '["The post is between 1,100 and 1,300 words.", "...", "..."]'
```

...becomes **five** criteria, not three. The rubric is bounded at four, so the
contract rejects it — that one was loud, and cheap, because nothing was
written. The dangerous case is the rubric that contains exactly *one* comma:
that parses as four criteria, **passes** the ≤4 check, and the first criterion
is stored **cut in half at the comma**. On chain, permanently, in the text a
judgment is made against. Offer #2 still carries that damage.

There is no escaping rule that fixes this, because the delimiter is also
ordinary punctuation. The lesson is not "quote it better":

> **Any contract text assembled by string-joining is a liability**, because the
> failure is silent and the artifact it corrupts is the promise itself.

**How the code handles it:** `relayer/scripts/seed-demo.ts` (which replaced a
bash+cast seeder, now deleted) passes `string[]` to viem as an actual array and
lets viem ABI-encode it — no delimiter is ever invented. It also **reads every
rubric straight back off the chain after creating the offer** (`assertRubric`)
and compares item-for-item against the source, because a rubric that lost a
clause is not detectable by reading the offer: it just looks like a terse
criterion. This is the same principle as D12 — the stored bytes are the
authority, so verify them rather than trusting the write.

**And if a bad rubric does land:** cancelling is *not* the fix. `cancelOffer`
sets `stage = NONE` but **keeps `p.seller`**, and `fetchAllPurchases` filters on
`seller !== ZERO` — so a cancelled offer still renders in the list, as
`STAGE_INFO[STAGE.NONE]` = "Not found / No record exists for this purchase."
That is a worse artifact than one slightly-wrong sentence.

---

## Repository shape

```
contracts/   Foundry project — Base escrow (Solidity, zero deps)
genlayer/    Intelligent contract (Python / GenVM) — the judgment layer
relayer/     Node service — GenLayer -> Base bridge
frontend/    Next.js App Router + Tailwind — deployed to Vercel
scripts/     local utilities (key generation)
docs/        DATA_MODEL.md, SECURITY.md, DEPLOY.md
.github/     CI — all heavy compute runs here
```

---

## Open questions / not yet decided

- Whether a GenLayer contract deploy requires a fee on the target network (the
  migration doc says detect gaslessness from the estimate, not the name).
- ~~**Blocked on the user:** the GitHub token lacks the `workflow` scope.~~
  **RESOLVED — no longer true.** Re-checked 2026-09-12 (Session 15):
  `gh auth status` reports `Token scopes: 'gist', 'read:org', 'repo', 'workflow'`,
  so `.github/workflows/ci.yml` **can be pushed**, and it is committed and in
  sync. The scope was granted at some point after Session 7; Session 13 had
  already recorded the same scopes, which is what made the older claims in
  PROGRESS.md stale. Kept struck through rather than deleted so the earlier
  reasoning stays traceable, but **do not act on it** — there is no blocker here
  and no `gh auth refresh` needed.
- **Solved 2026-09-11, session 8:** `frontend/` now **is** typechecked and
  built. `npx tsc --noEmit` exit 0 and `npx next build` exit 0, nine routes,
  against the locked versions in `package-lock.json`. Run in a scratch copy at
  `%TEMP%\recourse-tsc` so the heavy compute stayed off the 8 GB machine and out
  of the repo; the source compiled is byte-identical to the repo's. Vercel is no
  longer the first compiler. It is still the first *host*, so a deploy remains
  the real proof.
- **CRITICAL PATH — the GenLayer deploy is blocked by the *network*, not by code,
  and the CLI version was the first real defect.** Established by measurement on
  2026-09-11. `sourceContract` on the escrow is immutable, so the Base escrow
  deploy cannot start until a judgment contract address exists.

  1. **The GenLayer CLI MUST be `0.40.0-rc.3`, not 0.37.1.** The installed CLI
     had **zero** occurrences of `studio-dev`/`studioDevnet`/`61997` in its
     bundle — it structurally could not target the network the migration doc
     requires. The `rc` dist-tag (`0.40.0-rc.3`) is the "matching RC" the doc
     means. Upgraded 2026-09-11. **Re-check this after any `npm i -g genlayer`.**
  2. **studio-dev is gasless for EVM gas but NOT for the consensus fee — and the
     account must hold GEN.** `eth_gasPrice` is `0x0` and `effectiveGasPrice`
     came back `0x0` on a transaction that succeeded, so gas really is free.
     That is what made "studio-dev needs no faucet" look true, and **it is
     false**: the GenLayer fee deposit is paid from a real balance. Measured
     2026-09-11 — an unfunded account ends every deploy `NO_MAJORITY` with **no
     activator**; the account that succeeded, `0x81D6bF84…93f4`, holds
     **48.6 GEN** and its transaction returned `status: 0x1`. A deploy with no
     fee reverts `FeeValueMustBeNonZero(1)`, and with a zero balance the fee
     cannot be paid at all, so the fee *amount* makes no difference (1 wei and
     0.01 GEN behave identically). `estimate-fees` cannot help: the public RPC
     has no `sim_getFeeConfig` and no `gen_dbg_traceTransaction`.
     **Fix (applied 2026-09-11): the CLI now has a second account, `deployer`
     (`0xe5Fe9119…a7b`), imported from `.secrets/deployer.json` and set active.
     Faucet that address and the deploy proceeds.** See the CLI-accounts table
     under *Key addresses and paths*.
  3. **An unfunded transaction is never activated, and it does not say so.**
     Every attempt ends `status: FINALIZED`, `result_name: 'NO_MAJORITY'`,
     `num_of_rounds: '0'`, `votes_committed: '0'`, with `activator` and
     `last_leader` both empty. **This is a symptom of (2), not a separate
     fault** — the earlier reading of it as "studio-dev is not validating" was
     wrong, and the network is fine: a funded account transacted successfully
     on it in the same window. A 300-block scan finding only our own
     transactions is explained by the network being nearly idle, not broken.
  3b. **☠️ RETRACTED — the control was invalid, and the conclusion it supported
     was wrong.** An earlier session ran a 12-line trivial contract "carrying the
     same `Depends` header" from our account, saw it fail identically, and
     concluded *"the contract is NOT the problem"*. **That inference does not
     hold:** the control shared the exact defect it was meant to isolate — the
     v0.2.x `Depends` header (`1jb45aa8…`), which studio-dev does not serve. Two
     things broken the same way fail the same way; that is agreement, not
     exoneration. The schema error **was** the contract, and Session 10 fixed it.
     **The lesson to keep: a control must differ from the suspect in the
     dimension under test.** A control that shares the suspect's most likely
     fault tests nothing, and a green-looking "it fails the same way" is
     evidence of *shared cause*, not of innocence.
  4. **The Bradbury block is arithmetic, not a mystery.** The stranded tx at
     nonce 284 bid 0.17322855 gwei. Replacement needs a **10% bump**
     (0.1906 gwei) and the network only suggests 0.1875 gwei — it misses by
     ~1.6% and the CLI exposes no gas-price flag. Separately, that RPC
     **load-balances across nodes with unsynchronised mempools**: one hash
     polled three times returned `null`, `null`, `FOUND`.

  **Deploy-proven:** the judgment contract *does* deploy. On studionet (61999) it
  reached `MAJORITY_AGREE` at **`0x3bb55747305282DBDbD6baC4215f4796b0Bc12C6`**.
  That address is on the wrong chain for the submission and cannot be used, but
  the run carries a fact that matters: **it succeeded while the contract still
  carried the v0.2.x `Depends` header.**

  **Therefore the two networks serve different SDK runners.**
  **studionet (61999) serves v0.2.x; studio-dev (61997) serves v0.3.0.** This is
  the single fact that makes every earlier observation coherent: the same file
  deployed on one and failed `Could not load contract schema` on the other, and
  no amount of fee-tuning or retrying could have closed that gap. **A contract
  may not be portable across the two networks** — migrate before moving a
  contract between them, and never treat a studionet success as evidence that
  studio-dev will accept the same bytes.
- **Issue 4 from `genlayer-known-money-rails-issues.md` is unmeasured for us.**
  Bradbury rejects deploys whose **compiled artifact** exceeds ~39,869 B.
  `recourse_judgment.py` is 21,296 B of *source*; the artifact size is what
  matters and has not been measured. Details and the minify fallback are in
  [docs/MONEY_RAILS_AUDIT.md](./docs/MONEY_RAILS_AUDIT.md). Issues 1–3 do not
  apply — the judgment contract has no payout rail and no payable method.
  **Issue 3's one real gap is now closed:** `RecourseEscrow.totalHeld()` reports
  what the contract's books say it holds, to be compared against
  `usdc.balanceOf(escrow)`. It is a view with no caller — the monitoring job that
  would alert on a divergence is not written, so the gap is closed for a human
  checking and open for a machine watching.
- ~~The user's demo/browser wallet address~~ — **answered 2026-09-11.**
  `0x0DE10708F8c6DF7b73068d53def715A70C0f340D`, key in `.secrets/demo.json`.
  Still needs Base Sepolia ETH (it has none), and USDC if it plays the buyer.
