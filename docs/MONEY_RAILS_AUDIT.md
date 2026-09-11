# Recourse against the GenLayer money-rails issues

`genlayer-known-money-rails-issues.md` (written for Proofmark, formerly Aegis)
lists four defects found on live StudioNet/Bradbury transactions. This file
records the result of running its applicability checklist against Recourse.

**Result: Recourse is exposed to none of Issues 1–3, and Issue 4 is a live
deploy-time risk that has not yet been measured.**

The important qualifier: this is clean *by architecture, not by audit*. The
judgment contract was written to hold no money before this checklist existed,
so the checks below confirm a decision rather than repair a bug. That is worth
stating plainly, because a clean checklist on a contract that could never have
failed it is weaker evidence than it looks.

---

## Issue 1 — IC→IC transfer to an EOA silently fails

**Check:** `grep -rn "get_contract_at\|emit_transfer" --include=*.py .`
**Result: zero hits.**

`genlayer/contracts/recourse_judgment.py` has no payout rail at all. It returns
a verdict dict and nothing else; the header states "This contract holds no money
and cannot move money." There is no `emit_transfer`, so there is no rail that
could be pointed at an EOA by mistake.

This is the strongest form of the fix: the defect cannot be introduced without
first adding a value-transfer facility that the contract does not have and does
not need.

## Issue 2 — a reverted payable call retains the attached value

**Check:** payable methods, `gl.message.value`, `self.balance`.
**Result: zero hits.**

There is no `@gl.public.write.payable` anywhere in the repo, so there is no
branch that could revert while holding a caller's value. Value never enters the
GenLayer side, so there is nothing for a revert to retain.

Note the doc's corollary — "keep nondeterministic work out of payable methods;
split into a deterministic payable step and a separate non-payable step that
runs the LLM consensus." Recourse already has that shape, one layer up:

| Doc's recommendation | Recourse |
|:--|:--|
| deterministic payable step | `RecourseEscrow` on Base (Solidity, holds USDC) |
| separate non-payable consensus step | `recourse_judgment.py` (nondeterministic, holds nothing) |

The LLM call and the money are in different execution environments on different
chains, joined by a signed message the escrow verifies. A judgment failure
reverts a call with no attached value, so nothing is burned and the dispute is
retryable.

## Issue 3 — "it showed accepted" ≠ "it worked"

This one does **not** map onto the GenLayer contract, because no value moves
there. But the underlying rule — *a parent transaction's success is not evidence
that value moved* — applies to the bridge, which is where Recourse's real
money-out risk lives.

Where it is handled today:

- The escrow's `Settled` event is the record, and the UI reads balances and the
  settlement split from it rather than from a transaction hash.
- `confirm()` in `frontend/src/lib/escrow.ts` checks `receipt.status` and throws
  on `reverted`, so a mined-but-failed transaction is not reported as success.
- The relayer verifies the escrow accepted the settlement on chain before
  recording it as done in `.relayer-state.json`.

**Gap, stated honestly:** there is no reconciliation view that compares the
escrow's USDC balance against the sum of what its ledger says it holds. That
invariant is checkable on Base with a plain `balanceOf`, and it is not currently
exposed anywhere. The doc's checklist asks for exactly this, and Recourse does
not have it. It is a real gap, not a theoretical one — it is the only way a
retained-value leak in the escrow would become visible.

> **Closed 2026-09-11.** `RecourseEscrow.totalHeld()` now returns what the
> contract's own books say it is holding — the price of every FUNDED, DELIVERED
> or DISPUTED purchase, plus the bond of every DISPUTED one. Compare it against
> `usdc.balanceOf(escrow)`; a surplus means value arrived with no ledger entry.
> It is covered by 10 tests that assert the two agree at every stage of the
> lifecycle, including after both a release and a refund. Escrow size went
> 16,403 → 16,651 B runtime (7,925 B under the EIP-170 limit); suite went
> 112 → 122 tests, all passing.

## Issue 4 — Bradbury's per-transaction pubdata limit

**Relevant, unresolved.** Bradbury rejects deploys whose **compiled artifact**
exceeds roughly **39,869 B**. The source file size is not the number that
matters.

| Measurement | Value |
|:--|:--|
| `genlayer/contracts/recourse_judgment.py` **source** | 21,296 B |
| Bradbury compiled-artifact ceiling (observed) | ~39,869 B |
| Recourse compiled artifact | **not yet measured** |

The reference repo saw a ~72 KB source compile to ~37 KB, so a 21 KB source
compiling to something under the cap is plausible — but plausible is not
measured, and treating "it would probably fit" as a result is how the reference
project got bitten. **This must be measured before the Bradbury deploy is
trusted.**

If it does come in near the cap, the reference implementation's approach is the
one to copy: a mechanical minify step (`e2e/minify_contract.py` in that repo)
that strips comments, docstrings and blank lines to produce a deploy artifact
*from* the canonical source, so the two cannot drift, plus a test that runs
against the minified artifact rather than only the full source.

Recourse's contract is comment-heavy by design — the file's preamble and the
reasoning around `_build_prompt` and `_clamp` are a large fraction of its bytes
— so if the artifact is close to the cap, minification has real headroom to
recover without touching behaviour.

---

## What to do next

1. **Measure the compiled artifact** for `recourse_judgment.py` before deploying
   to Bradbury. This is the one open item from this checklist.
2. ~~**Add an escrow reconciliation check**~~ — **done 2026-09-11**:
   `RecourseEscrow.totalHeld()`, with 10 tests. See the Issue 3 section above.
   The remaining half is a monitoring job that alerts when `totalHeld()` and
   `balanceOf(escrow)` diverge on a live deployment; the view exists, nothing
   watches it.
3. Issues 1 and 2 need no action. Re-run both greps if a payout rail is ever
   added to the judgment contract; the checks are only meaningful while the
   contract holds nothing.
