# Recourse — Security Model

**Read this before trusting anything the app says.**

Recourse is a testnet prototype built for a hackathon. It is not audited, it
holds no real money, and one of its components is trusted in a way the word
"escrow" usually implies it is not. This document says plainly where the trust
sits, what the code does to bound it, and what is still open.

---

## 1. The one-sentence version

**The escrow on Base is the authority on money; GenLayer is only an opinion.**

Every figure the UI shows — the split, the refund, the bond — comes from the
`Settled` event on Base. Nothing is ever read back from GenLayer and presented
as fact. GenLayer produces a verdict; the escrow decides what that verdict is
worth, and it will not accept one that contradicts its own records.

The corollary matters as much as the rule: **if GenLayer and Base disagree, Base
wins, and the disagreement is visible** — the settlement either happened on Base
or it did not.

---

## 2. This is not trustless, and the relayer is why

A relayer process watches GenLayer for finalized judgments and carries them to
the escrow on Base, calling `settle()` with a signed decision.

**That relayer is a trusted prototype component.** It is a single Node process
holding a single key. There is no light client, no ZK proof of GenLayer
consensus, no threshold committee, and no challenge window. If that process is
compromised, or if whoever runs it decides to misbehave, they can push a
dishonest settlement.

Calling this "trustless" would be false. Saying "the escrow is on-chain" is
true and beside the point — the escrow faithfully executes a decision it was
handed.

### What bounds the damage anyway

The relayer cannot simply name a number. `settle()` runs **sixteen checks**
before it moves anything, and the last four constrain the verdict's *shape*
independently of who signed it:

| # | Check | What it stops |
|--:|:--|:--|
| 1 | `whenNotPaused` | (owner can halt settlement) |
| 2 | `p.stage == DISPUTED` | settling an undisputed purchase |
| 3 | — same check — | settling a purchase twice |
| 4 | `!nonceUsed[d.nonce]` | replaying a decision |
| 5 | `d.purchaseId < nextPurchaseId` | settling a purchase that does not exist |
| 6 | `d.sourceChainId == sourceChainId` | a decision minted for a different chain |
| 7 | `d.sourceContract == sourceContract` | a decision from a different judgment contract |
| 8 | `promiseHash` / `rubricHash` match | a verdict about *different terms* than the ones agreed |
| 9 | `evidenceRoot` matches | a verdict about evidence other than what is on chain |
| 10 | `d.finalized` | carrying a judgment GenLayer has not finalized |
| 11 | `met & ~full == 0` | criteria bits outside the purchase's range |
| 12 | `RELEASE ⇒ refundBps == 0 ∧ all criteria met` | "released" while refunding, or releasing with a requirement unmet |
| 13 | `FULL_REFUND ⇒ refundBps == 10_000 ∧ not all met` | a full refund with every requirement met |
| 14 | `PARTIAL_REFUND ⇒ 0 < bps < 10_000 ∧ not all met` | partial refunds that are really releases or full refunds |
| 15 | `msg.sender == relayer` | anyone but the relayer delivering a decision |
| 16 | `_recover(hash, sig) == relayer` | a forged or altered decision |

Checks 15 and 16 are both required on purpose. A signature alone would make
settlement permissionless — a defensible meta-transaction design, but it means a
decision the relayer signed and then thought better of can be pushed by anyone
who saw it. Neither gate can change *what* a decision says, only whether it can
be delivered.

**The honest limit of these checks:** they guarantee a verdict is *internally
coherent and about the right dispute*. They do not guarantee it is *correct*.
A compromised relayer can still settle a genuine dispute the wrong way — it
just has to lie within the schema. Requirements 8–9 narrow this a lot: the
relayer cannot invent different terms, because the hashes it must match were
fixed on chain before the dispute existed.

---

## 3. The payout rule

```
refund       = price × refundBps / 10_000
toBuyer      = refund
toSeller     = price − refund
bondToBuyer  = (outcome == RELEASE) ? 0 : bond
bondToSeller = bond − bondToBuyer
```

The dispute bond is returned to the buyer for **every** outcome except an
outright `RELEASE` — including `UNDETERMINED`.

That last one is a deliberate policy choice, not an oversight. An inconclusive
judgment does **not** establish a breach, so it would be wrong to pay it out as
one. But if `UNDETERMINED` forfeited the bond, then a seller could grief a buyer
into silence: dispute anything, and an ambiguous verdict costs the buyer money.
Returning the bond makes an inconclusive outcome cost the buyer nothing but
time. Full reasoning is in `docs/DATA_MODEL.md` §6.

---

## 4. Key blast radius

Every key in the system and the worst thing it can do.

| Key | Lives in | Can do | Worst case if compromised |
|:--|:--|:--|:--|
| **Escrow owner** | `.secrets/deployer.json` | `pause`, `unpause`, `setRelayer`, `transferOwnership` | **Can rotate the relayer to a key it controls, then settle any dispute to any outcome.** There is no timelock and no two-step handover. The contract has no `withdraw` and no upgrade path, so funds cannot be swept directly — but `setRelayer` reaches the same money indirectly. This is the honest version of the row. |
| **Relayer signer** | `.secrets/relayer.json` | `settle()` only | Can settle any disputed purchase to a verdict of its choosing, subject to §2's checks, and can censor by refusing to relay. Cannot touch funds that are not already in a disputed purchase. |
| **Deployer / faucet** | `.secrets/deployer.json` | Pays gas for deploys; same address as owner in this build | Same as the owner row. A real deployment should separate these. |
| **Demo wallet** | `.secrets/demo.json` | Signs as buyer/seller in the browser demo | Can spend its own testnet balance. No privileged role. |
| **GenLayer deployer** | `~/.genlayer/keystores/default.json` — the CLI's own keystore, outside this repo | Deploys and updates the judgment contract | Could deploy a contract whose address the escrow does not accept (harmless). `sourceContract` is immutable, so this key cannot re-point the live escrow. |

**No key material is in the repository.** `.secrets/` is gitignored
(`.gitignore` line 2; `git check-ignore -v .secrets/demo.json` confirms it), and
`git ls-files` shows the only tracked `.env` files are the two `.env.example`
templates.

---

## 5. Why the judgment contract holds no money

The GenLayer contract is deliberately incapable of moving value. It has **no
`emit_transfer`, no `get_contract_at`, no payable method, and no `self.balance`
accounting.** It returns a verdict dict and nothing else.

This was a design choice made before the money-rails audit in
`docs/MONEY_RAILS_AUDIT.md`, and it happens to make Recourse structurally immune
to two defects that bite value-handling GenLayer contracts:

- **IC→IC transfers to an externally-owned account silently fail** while the
  parent transaction reports success. There is no transfer rail here to
  misdirect.
- **A reverted payable call retains the attached value** on GenLayer — reverting
  is not a refund. There is no payable method here to revert.

The layout also matches the recommended split: the deterministic payable step
(holding USDC) is Solidity on Base, and the nondeterministic consensus step (the
LLM judgment) is non-payable on GenLayer. A judgment failure reverts a call with
no attached value, so nothing is burned and the dispute is retryable.

---

## 6. Evidence integrity

The promise, the requirements, the delivery notes and the dispute notes are
stored **verbatim** on Base as strings, and hashed by the contract itself. No
layer hashes text on its own — the frontend never computes a hash, so it cannot
desync from the chain, and the relayer carries the hashes through rather than
recomputing them.

**The rule that holds this together: no layer may trim, collapse, or normalise
text before hashing.** The escrow reverts on over-length text rather than
truncating, so `sha256(bytes(stored_text))` always describes exactly what the
parties read. The Solidity escrow and the GenLayer contract are two
implementations of these hashes in different languages on different chains, and
neither can detect that the other started stripping whitespace — the escrow
would stay internally consistent while every relayed package failed its hash
check, leaving real disputes permanently unjudgeable.

`docs/vectors/hash-vectors.json` is the contract between the two
implementations. `scripts/gen-hash-vectors.mjs` generates both that file and
`contracts/test/HashVectors.generated.sol`, and CI regenerates and diffs them.

### Prompt injection

Both parties to a dispute are self-interested and both control text that reaches
the model. Every field they control is fenced in explicit `BEGIN_EVIDENCE` /
`END_EVIDENCE` markers, and the contract-authored prompt states — before *and*
after the evidence — that nothing inside those markers is an instruction.

The model's output is then passed through `_clamp`, which is deterministic
contract code. **The model does not decide the schema.** Anything outside it, out
of range, or internally contradictory is repaired or rejected there.

---

## 7. Known gaps

Listed because a security document that only lists strengths is marketing.

1. **No reconciliation view.** Nothing compares the escrow's actual USDC balance
   against what its own accounting says it should hold. On Base this is a plain
   `balanceOf(escrow)` call, and it is not exposed. If the escrow ever retained
   value it should not have — via a revert or a transfer quirk — nothing would
   surface it. Flagged in `docs/MONEY_RAILS_AUDIT.md`.
2. **The relayer is unverified against a live deployment.** Its pure logic is
   covered by 30 local tests, including the coherence check that must agree with
   Solidity. Everything that touches a chain is untested until a deploy exists.
3. **The GenLayer SDK surface is unverified.** The judgment contract's
   deterministic logic has been executed (11/11), but nothing has loaded it
   through `genvm-lint`, so its `Depends` header and nondeterminism API names
   remain "read from the docs" rather than "confirmed by the tool".
4. **`pause()` is a single-key power with no timelock.** An owner key compromise
   can halt settlement. It cannot move money, but it can freeze disputes.
5. **No rate limiting or bond escalation.** A buyer with funds can open disputes
   freely; the bond deters but does not prevent.
6. **Wallet addresses are not identity.** One person can hold many, several can
   share one. Nothing here is a reputation score, and the UI says so.

---

## 8. Testnet only

Everything here runs on **Base Sepolia** and **GenLayer Bradbury/Studio**. There
are no real funds anywhere in this system. Do not deploy it to mainnet as it
stands: the relayer trust model in §2 is the blocker, and it needs a real bridge
before it handles value anyone cares about.
