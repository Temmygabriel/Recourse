# MEMORY.md — Recourse

Durable project memory. Read this first when resuming work. It records
**decisions and constraints**, not a work log — for "what happened when", see
[PROGRESS.md](./PROGRESS.md).

Last updated: 2026-09-11

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
| Demo | 0 | 0 |

Two things worth not re-deriving:

- **The relayer does not need USDC.** It only ever calls `settle()`, which moves
  money the escrow already holds and costs nothing but gas. The 20 USDC the user
  put there is harmless but not used by any code path; if a later step seems to
  want it, that is a sign the relayer is being asked to do something it should
  not be doing.
- **0.001 ETH is not a small number here.** Base Sepolia gas is cheap enough
  that this is hundreds of `settle()` transactions. Gas is not the binding
  constraint on this build; USDC and time are.
- **The demo wallet has no ETH**, so it cannot sign anything yet. It needs gas
  before the demo, and USDC as well if it plays the buyer (the buyer pays the
  price plus the bond; the seller pays nothing but gas).

### Known non-secret addresses

| Thing | Address |
|:--|:--|
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| RecourseEscrow (Base Sepolia) | _not yet deployed_ |
| GenLayer judgment contract | _not yet deployed_ |

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
- **Blocked on the user:** the GitHub token lacks the `workflow` scope, so
  `.github/workflows/ci.yml` cannot be pushed until they run
  `gh auth refresh -s workflow`.
  **Re-checked 2026-09-11, session 7:** still
  `Token scopes: 'gist', 'read:org', 'repo'`.
  Two consequences, and they are no longer the same consequence:
  - The **Solidity** no longer needs CI to be verified — `forge build` and
    `forge test` run locally (112/112). What CI adds there is a second opinion
    on a different compiler/platform, not first light.
  - The **GenVM SDK surface still needs CI**, because `genvm-lint` is what
    proves the contract's `Depends` header and nondeterminism API names are
    real. Nothing local substitutes for it.
  - `.github/workflows/ci.yml` exists **only in the working tree** — it is
    excluded via `.git/info/exclude`, so it is not backed up in git at all. If
    the working tree is lost before the scope is granted, that file is lost.
- **Also blocked, and now the bigger problem:** `frontend/` has never been
  typechecked or built. `next build` cannot run here (8 GB machine, and the user
  asked for heavy compute to happen on GitHub), so Vercel is currently the only
  thing that will ever compile the frontend. Until the repo is connected to
  Vercel, the eight routes are reviewed by reading, not by a compiler. A
  read-only audit found no build-breaking defect and two real runtime ones (both
  now fixed), but an audit is not a compiler.
- ~~The user's demo/browser wallet address~~ — **answered 2026-09-11.**
  `0x0DE10708F8c6DF7b73068d53def715A70C0f340D`, key in `.secrets/demo.json`.
  Still needs Base Sepolia ETH (it has none), and USDC if it plays the buyer.
