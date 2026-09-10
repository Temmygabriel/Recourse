# Recourse relayer

One job: take a dispute that is open on Base Sepolia, have GenLayer rule on it,
and deliver the ruling back to Base as a signed `SettlementDecision`.

```bash
npm install
npm run build
node --env-file=.env dist/index.js          # or: npm start
```

`DRY_RUN=true` signs and simulates every settlement against the real escrow but
never broadcasts — the right first run against a new deployment, and it still
exercises the escrow's own signature recovery, because `simulateContract` runs
`settle()` for real as an `eth_call`.

Configuration is documented in [`.env.example`](./.env.example). `--once` runs a
single sweep and exits, which is what CI uses.

---

## What it is not

**The relayer is a trusted prototype component; this is testnet-only.**

Base cannot verify GenLayer finality from inside an EVM contract. The
`finalized` field of a `SettlementDecision` is the relayer's assertion and
nothing else — an EVM contract has no way to read another chain's consensus
state. Every *other* field the relayer carries is re-derived and checked by the
escrow against its own storage, so a lying relayer cannot invent a payout, move
a purchase that is not disputed, judge text the chain never saw, or settle the
same dispute twice. But it can lie about whether GenLayer finished, and a
compromised relayer key plus a fabricated package is bounded only by what the
judgment contract would accept from a self-consistent claim.

That is the whole of the trust boundary, and it is one boolean. Closing it
properly needs a light client or an attestation bridge for GenLayer consensus on
Base, which is out of scope for this build. **Do not describe this system as
trustless.**

---

## Design decisions worth knowing before you read the code

**The nonce is derived, not counted.**
`nonce = keccak256(genlayerTxHash, purchaseId)`. A persisted counter would work
until the first crash; a derived one is a pure function of inputs that are
already unique. The consequence is that a *retry* reproduces the same nonce and
the second attempt reverts harmlessly on `"nonce used"`, while a genuinely new
verdict (after an appeal) comes from a new transaction and gets a new nonce.
Idempotency by construction rather than by careful bookkeeping — see
`deriveNonce` in `src/decision.ts`.

**The relayer reads what the escrow expects instead of deciding it.**
`sourceChainId`, `sourceContract` and the GenLayer key `"recourse:<chain>:<escrow>:<id>"`
are all read *from the escrow*. The first two are immutable, so a compromised
owner key cannot repoint them, and reading them means the relayer physically
cannot construct a decision that fails settlement checks 6 or 7.

**It checks its own hashing against Solidity before it spends anything.**
The relayer is the third implementation of the commitment hashes — after the
Solidity escrow and the Python judgment contract — and three implementations of
one hash is two too many without a check. So it recomputes every hash from the
text it just read off the chain and compares each against the escrow's own view
function (`verifyCommitments`). If Node's UTF-8 encoding ever differed from
Solidity's by a byte, the relayer stops instead of submitting a package GenLayer
would reject forever. This is the same failure mode as MEMORY.md D12, which was
a real bug in this project.

**It simulates before it broadcasts.**
`simulateSettle` runs the escrow's `settle()` as an `eth_call` with the exact
arguments and signature it would send, so checks 2–16 of the rejection list are
exercised for real — signature recovery included — with no transaction and no
gas. A malformed decision is reported with the contract's own revert reason,
before anything is spent. This is also why the local EIP-712 hash comparison
only *warns*: if it disagrees with the chain, one of the two is wrong and the
process cannot tell which, so the simulation stays the gate.

**It does not retry a failed evaluation.**
Retrying a round whose validators disagreed re-rolls the same dice. The
supported remedy is an appeal, which costs a bond and is a human decision, so a
failed evaluation is terminal and says so in the log.

---

## The flow, and where each step can fail

| # | Step | On failure |
|--:|:--|:--|
| 1 | Read the purchase from Base | retried next sweep |
| 2 | Verify commitments against the escrow | **terminal** — a hashing bug, retrying cannot help |
| 3 | `evaluate(key, package)` on GenLayer | retried; nothing was spent if submission failed |
| 4 | Wait for finality, read the verdict back | retried; resumption waits on the *same* tx |
| 5 | Validate and coherence-check the verdict | exceeds retry; a bad verdict is not a transient |
| 6 | Sign, recover locally, simulate `settle()` | logged with the contract's own reason, retried |
| 7 | Broadcast and confirm the receipt | retried with the same nonce |

State lives in `STATE_FILE` (`./.relayer-state.json`, gitignored) with one
record per purchase: `discovered → evaluating → evaluated → settled`, or
`failed`. `evaluating` is written *before* the wait for finality, which is what
makes a restart during a long wait resume instead of re-paying.

---

## When something goes wrong

**`genlayer evaluation failed`** — status or execution result was not
successful. Terminal. Options, in order of preference:

1. Re-run with the same purchase; the store marks it `failed` and will skip it,
   so delete that purchase's entry from the state file to retry the evaluation.
2. Appeal, which is the supported protocol remedy.

**`settle() would revert`** — the log line carries the contract's own reason.
The rejection list is documented on `settle()` in
`contracts/src/RecourseEscrow.sol`; the common ones:

| Reason | Meaning |
|:--|:--|
| `not disputed` | Something already moved this purchase. Harmless. |
| `nonce used` | This exact verdict was already delivered. Harmless — it is the idempotency working. |
| `wrong source chain` / `wrong source contract` | The escrow was deployed against a different GenLayer deployment than the one configured. |
| `promise mismatch` / `rubric mismatch` / `evidence mismatch` | The relayer's hashing disagrees with Solidity. A real bug — see step 2 above, which should have caught it earlier. |
| `not relayer` | The configured key is not the escrow's relayer. |
| `not finalized` | Should be impossible; the relayer only sets it after observing finality. |

**`genlayer chain matches the escrow` never prints** — the startup check found
the configured chain and the escrow's `sourceChainId` disagree. That is a
deployment error, not a runtime one.

---

## Appeals

A disputed round can be appealed, and this is the documented remedy for an
evaluation that failed or that a party believes was wrong. It is **not** wired
into the relayer, because a successful appeal pays 2.5× the bond and posting a
bond is a decision with money behind it — a human should make it.

Per the Consensus v0.6 migration notes, appeal with the SDK's own calls rather
than a raw `submitAppeal`, which can revert with `AppealRoundNotPermitted`:

```ts
const charge = await client.getAppealCharge({ txId });
await client.appealTransaction({ txId, value: charge });
```

Verified appeal escalation is 5 → 11 → 23 validators. Do not hardcode a smaller
sequence, and read the appeal duration from protocol state rather than assuming
one.

Once an appeal produces a new GenLayer transaction, the relayer picks the
dispute up on its next sweep: the new transaction has a new hash, so the derived
nonce is new, and the purchase is still `DISPUTED` on Base because nothing
settled it.

---

## What would have to change for mainnet

Listed so the gap is legible rather than implied:

- **`finalized` must stop being an assertion.** A GenLayer light client or an
  attestation bridge on Base. Until then the relayer is trusted for exactly this
  one bit.
- **The watcher must not poll.** It sweeps `getPurchase(1..purchaseCount())`
  each tick, bounded by `MAX_PURCHASES_PER_TICK`. That is linear in the number
  of purchases ever created and is fine for a demo; at scale it wants an event
  cursor over `DisputeOpened` with reorg handling.
- **The voting window must be checked, not assumed.** The demo relies on the
  buyer's `reviewWindow` being long enough for a GenLayer round to finalize.
  Production would want the escrow to require a review window of at least the
  appeal-inclusive round duration for the configured chain.
- **Key management.** The relayer key is a file on disk. It should be a KMS or
  an HSM, and rotating it is currently a two-step manual operation
  (`setRelayer` then update the config), during which settlements fail closed —
  which is the right direction, but it should be rehearsed rather than
  discovered.
