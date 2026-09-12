# Recourse

**Escrow for promises that need a judgment, not just a signature.**

A seller writes down what they will deliver and the criteria it will be judged
against. A buyer locks the money against that text. When the work arrives, the
criteria are checked — by an AI jury on GenLayer, against the promise as it was
written — and the money moves accordingly. If it doesn't, a human can read every
step of the reasoning that moved it.

Built for the **GenLayer Agent Tank — Track 4 (Onchain Justice)**.

> **This is a testnet prototype.** It runs on Base Sepolia and GenLayer Studio
> Devnet with valueless test tokens. It has not been audited. Do not put real
> money in it.

---

## The problem this is aimed at

Most "escrow" contracts are a locked box with a key held by one party. They
enforce *whether* someone pressed a button, not *whether the thing they promised
actually happened*. The hard part of a real escrow is not custody — it is the
judgment call: did this delivery satisfy the agreement?

That judgment is exactly what a plain EVM contract cannot make. It is expensive,
it is subjective, and it needs to read text. Recourse puts the judgment where it
can be made properly and keeps the money where it can be held properly.

## How it works

```
  seller                 buyer                    GenLayer              Base
    │                      │                          │                   │
    │  1. createOffer ─────┼──────────────────────────┼──────────────────▶│  promise +
    │     (promise text,   │                          │                   │  rubric hashed
    │      rubric, price)  │                          │                   │  on-chain
    │                      │                          │                   │
    │                      │  2. purchase ────────────┼──────────────────▶│  USDC locked
    │                      │                          │                   │
    │  3. submitDelivery ──┼──────────────────────────┼──────────────────▶│  delivery
    │                      │                          │                   │  hashed
    │                      │                          │                   │
    │                      │  4. openDispute ─────────┼──────────────────▶│  bond posted,
    │                      │     (+ dispute bond)     │                   │  text frozen
    │                      │                          │                   │
    │                      │                          │◀── 5. relayer ────┤  reads the
    │                      │                          │    submits the    │  frozen case
    │                      │                          │    frozen case    │
    │                      │                          │                   │
    │                      │                    6. AI jury decides:        │
    │                      │                    criteria met? in bad faith?│
    │                      │                          │                   │
    │                      │                          │─── 7. signed ────▶│  settle():
    │                      │                          │    decision       │  verified,
    │                      │                          │                   │  nonce burned,
    │                      │                          │                   │  funds split
```

**1–4 are ordinary escrow mechanics.** The interesting part is 5–7.

**Steps 1–4 (the promise).** `createOffer` stores the promise and rubric text
on-chain and hashes them. `purchase` pulls USDC into the contract. Both parties
can walk away before delivery. On delivery the notes are hashed too. If the
buyer does nothing for the review window, the seller can claim; if the deadline
passes undelivered, the buyer can refund. None of this needs GenLayer.

**Steps 5–7 (the judgment).** A dispute freezes the case. The relayer hands the
*frozen* promise, rubric, and evidence to GenLayer, where a jury of validators
each run the same evaluation and have to agree on a structured verdict —
`RELEASE`, `PARTIAL_REFUND`, or `FULL_REFUND`, with a per-criterion bitmap and a
short reason. The relayer then carries that verdict to Base.

**What Base verifies before moving a cent.** The escrow checks all of it, in
order, and reverts on any mismatch:

| # | Check | What it rules out |
|:--|:--|:--|
| 2–3 | purchase is in `DISPUTED` | settling twice; settling a purchase that was never disputed |
| 4 | `nonce` unused | replaying a decision |
| 5 | purchase exists | settling a phantom |
| 6 | `sourceChainId` matches | a decision from a different GenLayer network |
| 7 | `sourceContract` matches | a decision from a different judgment contract |
| 8 | promise + rubric hashes match | judging text other than what was agreed |
| 9 | evidence root matches | swapping evidence after the fact |
| 10 | `finalized` is set | settling on a merely-accepted result |
| 11–14 | verdict is internally coherent | "full refund" with every criterion met, partial refunds with none met, and similar contradictions |
| 15 | caller **is** the relayer | — |
| 16 | signature is from the relayer | — |

Gates 15 and 16 are deliberately both present. A valid signature alone would
make settlement permissionless — defensible as a meta-transaction design, but it
would mean a decision the relayer signed and then thought better of could be
pushed by anyone who saw it. Requiring the caller to also *be* the relayer costs
one comparison and removes that question.

## The trust model — read this before the demo

**The relayer is a trusted prototype component; this is testnet-only.**

This is the honest summary, and it is the thing most easily overstated:

- **Base cannot verify GenLayer finality from inside an EVM contract.** There is
  no light client, no proof, no bridge. The `finalized` flag in a
  `SettlementDecision` is an *assertion by the relayer*. Everything else in the
  decision is re-derived and checked on-chain (gates 2–14 above); `finalized` is
  the one field the chain takes on faith.
- **The relayer cannot invent a verdict's content, but it can choose whether to
  deliver one.** It cannot make the escrow pay out an amount the verdict
  doesn't support — the split is computed on-chain from `outcome` and
  `refundBps`, and the coherence checks constrain what those can be together.
  What it *can* do is refuse to relay, which stalls a dispute.
- **The relayer is a single key, not a quorum.** There is no threshold
  signature, no multi-sig, no dispute window on a delivered decision.

A production version of this needs the relayer replaced by something Base can
verify without trusting an operator — a light client, a ZK proof of GenLayer
consensus, or at minimum a threshold committee with a challenge window. None of
that is in this prototype. Calling it "trustless" would be false.

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full narrative.

### Key blast radius

Every key in the system, and the worst thing it can do. Required reading before
anyone is handed one.

| Key | Lives in | Can do | **Worst case if compromised** |
|:--|:--|:--|:--|
| **Escrow owner** | `.secrets/deployer.json` | `pause()`, `unpause()`, `setRelayer()`, `transferOwnership()` — and nothing else | **Can rotate the relayer to a key it controls, and then settle any disputed purchase to any outcome it likes, draining escrowed funds to a colluding party.** There is no timelock and no two-step handover. The contract has no `withdraw` and no upgrade path, so funds cannot be swept directly — but `setRelayer` reaches the same money indirectly, and that is the honest version of this row. |
| **Relayer signer** | `.secrets/relayer.json` | `settle()` only. Cannot withdraw, cannot pause, cannot change configuration | **Can settle any disputed purchase to a verdict of its choosing** (subject to the coherence checks), and can censor by refusing to relay. Cannot touch funds that are not already in a disputed purchase. |
| **Deployer / faucet key** | `.secrets/deployer.json` | Pays gas for deploys. Same address as owner above in this prototype | Same as the owner row. In this build it is intentionally one key; a real deployment should separate them. |
| **Demo wallet** | `.secrets/demo.json` | Signs as buyer/seller in the browser demo. Testnet only | Can spend its own testnet balance. No privileged role. |
| **GenLayer deployer** | The GenLayer CLI's own keystore, `%USERPROFILE%\.genlayer\keystores\` — **outside this repository entirely**. The active account is `deployer` | Deploys and updates the judgment contract | Could deploy a judgment contract whose address the escrow does not accept — harmless — or, if `sourceContract` were ever re-pointed, author a different judgment layer. `sourceContract` is immutable, so in practice this key cannot change what the live escrow accepts. |

**None of these keys are in the repository.** The Base keys live in `.secrets/`,
which is gitignored (`.gitignore` line 2 — `git check-ignore -v .secrets/demo.json`
confirms it). The GenLayer key is not even in the working tree; it sits in the
CLI's own keystore under the operator's home directory. The addresses are public,
and the README deliberately does not reproduce private key material.

This table is the honest version, and it is less flattering than "the admin key
can only pause". `setRelayer` is a real power over money. It is listed that way
on purpose.

## Repository layout

```
contracts/          Foundry — the Base escrow
  src/RecourseEscrow.sol     the money, the state machine, the checks
  test/                      122 tests: state machine + attack paths
genlayer/           the judgment layer
  contracts/recourse_judgment.py    the AI jury
  tests/                      pure-Python logic tests (no network)
relayer/            Node — carries decisions from GenLayer to Base
  src/                        pure logic first, network second
frontend/           Next.js — eight pages
docs/               DATA_MODEL.md, SECURITY.md, DEPLOY.md, specs/
scripts/            key generation, hash-vector generation
```

**Nothing here trusts a string it did not hash itself.** Text lives off-chain;
`bytes32` commitments live on-chain; every layer re-derives the hash and rejects
a mismatch. The name and bounds of every field are in
[`docs/DATA_MODEL.md`](docs/DATA_MODEL.md).

## Status

Honest about what is proven and what is not.

| Component | State |
|:--|:--|
| Base escrow | **Deployed to Base Sepolia** at `0x32288128Ff07Fc9e443161c1F336b784508a056A`. Compiles clean; **122/122 tests pass** (`forge test`). Runtime 16,651 B — 7,925 B under the EIP-170 limit. All seven immutables verified on-chain. |
| GenLayer judgment contract | **Deployed to studio-dev (61997)** at `0x0f385a4e7400a0693776D19102e0be75D334ce1c` — `FINALIZED` · `MAJORITY_AGREE`, 5 validators, 5 votes revealed. The schema endpoint returns all four methods. |
| Relayer | Written; logic tested without dependencies (30 tests). **Still has not run against a live GenLayer** — this is the significant gap. |
| Frontend | Written; typechecks (`tsc --noEmit`) and builds (`next build`, 8 pages) locally against the locked dependencies. Not yet hosted. |
| Deployed end-to-end demo | **Not yet exercised.** Both contracts are live, but no verdict has travelled from GenLayer to Base, and no money has moved. |

**Be precise about what "deployed" does and does not mean here.** The two
contracts exist on their chains and their immutable wiring is verified — that is
real, and it was the hard part. But **nothing has completed the full loop**: the
relayer has never carried a judgment to `settle()`, so the path that actually
moves money is untested against a real network. Treat the deployment as
infrastructure proven and the end-to-end flow as unproven.

Two further limits worth stating plainly:

- The frontend was compiled in a scratch copy outside the repo (this is an 8 GB
  Windows box), so its build is verified but it has never been served.
- The judgment contract is deployed to **studio-dev**, a preview network that
  **may reset**. The escrow's `sourceContract` is immutable, so a reset means
  redeploying the escrow too — it cannot be repointed.

## Running it

See [`docs/DEPLOY.md`](docs/DEPLOY.md) for the full runbook. In outline:

```bash
# Contracts (needs Foundry)
cd contracts && forge test

# Judgment logic (no dependencies)
python genlayer/tests/test_judgment_logic.py

# Relayer
cd relayer && npm ci && npm test

# Frontend
cd frontend && npm ci && npm run dev
```

The frontend needs `NEXT_PUBLIC_ESCROW_ADDRESS` set. It resolves that lazily
rather than at module scope, so a missing value produces a message in the
browser naming the fix, instead of a failed build.

## What this is not

- **Not trustless.** The relayer is a trusted component. See above.
- **Not audited.** It is a hackathon prototype.
- **Not for real money.** Base Sepolia and GenLayer Studio Devnet, test tokens
  only. Studio Devnet may be reset without notice.
- **Not decentralised governance.** One owner key. See the blast radius table.

## License

MIT — see [LICENSE](LICENSE).
