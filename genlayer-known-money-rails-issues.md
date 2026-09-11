# GenLayer money-rails: two known issues that bite every value-handling contract

**Audience:** a coding assistant working on a *different* GenLayer intelligent contract.
**Purpose:** check whether that contract has either of these defects, and fix it before a
reviewer or a user finds it the hard way.
**Origin:** both were found the hard way in this repo (Proofmark, formerly Aegis) on live
StudioNet/Bradbury transactions. Everything marked **PROVEN LIVE** was observed on-chain, not
inferred from docs.

---

## Issue 1 — Paying a plain wallet with an IC→IC transfer "succeeds" and silently fails

### Symptom
Everything looks fine at the top level. The parent transaction finalizes with no error. But
the value never lands in the recipient's wallet, and the child transaction underneath shows
`GenVM Execution ERROR`.

### What actually happens
Payees that are **externally-owned accounts** (a normal wallet address — a buyer, a user,
an LP) have **no intelligent contract deployed at them**. So both of these are wrong for an
EOA payee:

```python
# ❌ WRONG for an EOA payee
gl.get_contract_at(payee_address).emit_transfer(value=u256(amount))
```

That compiles to an **IC→IC PostMessage**. An empty address cannot receive it. The child
transfer errors; your contract's internal ledger has already been debited; the wallet is
never credited. **The parent tx still reports success**, which is why this is dangerous —
nothing in your happy-path assertions catches it.

### The fix
Use an external EVM contract-interface stub, which compiles to an **EthSend** that credits a
chain-layer EOA normally:

```python
@gl.evm.contract_interface
class _EoaPay:
    class View:
        pass
    class Write:
        pass

# ✅ CORRECT for an EOA payee
_EoaPay(payee_address).emit_transfer(value=u256(amount))
```

External messages execute **only on finality**, so state is fully committed before the
transfer runs — you keep the reentrancy safety that `on='finalized'` used to give you.

### How to check for it in your project
```bash
grep -rn "get_contract_at" --include=*.py .
```
Every hit that targets is a wallet address rather than a deployed contract needs to move to
the stub rail. Then verify live: take a money-out transaction hash and enumerate its
**child transactions** — each child must be `FINALIZED` with contract = your contract and
recipient = the payee EOA, and **no `Execution ERROR`**.

**PROVEN LIVE (this repo):** pre-fix, every payout child finalized `GenVM Execution ERROR`
and no wallet was ever credited. Post-fix, the payout tx produced two children, both
`FINALIZED`, contract → buyer EOA, no error.

---

## Issue 2 — A reverted payable call does NOT refund the attached value

### Symptom
A payable method reverts. The sender's balance is debited anyway, and the **contract's**
balance goes **up** by the attached value. Nothing in your ledger accounts for it.

### What actually happens
On GenLayer, when a payable call reverts, the value that was attached to the call is **not
returned to the sender and not destroyed** — it is **retained by the contract**, with no
ledger entry. So:

- "the tx reverted, so the user got their money back" is **false**.
- "reverting is the safe way to reject a bad payable call" is **false**.

### PROVEN LIVE
Transaction `0x429b0177888940543c650593d8d583326f67cfb9cdbafb2097fd611f15ab752f`
(StudioNet): a funded `issue_policy` call finalized `GENVM RESULT: ERROR`. No policy was
readable afterward — and the contract's explorer balance rose from **19.06 → 19.12 GEN**
(0.06 GEN retained) with no corresponding accounting entry.

### The fix — reject-and-refund in the same transaction
The only in-contract guarantee of non-retention is: **never revert a payable call on a
condition the caller can fix.** Instead, accept the call, refund in full inside the same
transaction, record why, and return normally.

```python
def _reject_payable(self, reason: str, job_key: str = "") -> None:
    paid = int(gl.message.value)
    if paid > 0:
        _EoaPay(gl.message.sender_address).emit_transfer(value=u256(paid))
    self.payable_rejections[f"{key}|{job_key}"] = (
        f"{reason} — rejected and refunded {paid} atto in this transaction; "
        f"the contract retained nothing"
    )
```

Then every validation branch on a payable method becomes `return self._reject_payable(...)`
instead of `raise`. Because the call now **succeeds**, there is no revert message to read —
so store the reason on-chain and expose a view for it:

```python
@gl.public.view
def get_rejection(self, payer: str, job_id: str = "") -> str: ...
```

Corollary: keep **nondeterministic work out of payable methods** where you can. Split into a
deterministic payable step (escrow / record) and a separate **non-payable** step that runs
the LLM/web consensus. Then a judgement failure reverts a call with **no attached value**,
so nothing is burned and the action is retryable.

### How to check for it in your project
1. List every `@gl.public.write.payable` method.
2. For each, count the `raise` statements that can fire on caller-fixable input.
3. Any payable method that reverts on user error **retains that user's value**. Convert those
   branches to reject-and-refund.
4. Add a view that reconciles `self.balance` against your internal ledger (sum of pools +
   escrowed amounts). Any surplus is value retained by a past revert. Exposing that number
   makes the invariant independently checkable.

---

## Issue 3 — "It showed accepted" ≠ "it worked"

Both issues share a root cause: **the parent transaction's status is not evidence that value
moved.** A parent can finalize successfully while

- a child transfer errored (Issue 1), or
- the parent itself reverted and quietly kept the money (Issue 2).

### Minimum verification for any money-out path
1. Get the parent tx receipt.
2. Enumerate its **child transactions**; assert each is `FINALIZED` and error-free.
3. Assert the recipient is the expected EOA (not your own contract).
4. Re-read the on-chain balances **after** finality and reconcile them against the internal
   ledger.
5. For a revert, extract the actual reason from the receipt:
   `consensus_data.leader_receipt[].result.payload` — a shallow scan of the receipt often
   misses it.

### Quick applicability checklist for the other project
- [ ] Any `get_contract_at(...).emit_transfer(...)` where the target is a wallet → **Issue 1**.
- [ ] Any `@gl.public.write.payable` that can `raise` → **Issue 2**.
- [ ] Any payout/refund path tested only by "the tx succeeded" → **Issue 3**.
- [ ] Any payable method that also runs an LLM/web consensus call → consider splitting it.
- [ ] A reconciliation view comparing `self.balance` to the internal ledger — if it doesn't
      exist, a retained-value leak would be invisible.

---

## Issue 4 — Bradbury's per-transaction pubdata limit rejects large contracts at deploy

### Symptom
A deploy that works on StudioNet fails on Bradbury with `BlockPubdataLimitReached`. Nothing
about the contract is *wrong* — it is simply too big once compiled.

### The limit
Bradbury enforces a **per-transaction pubdata cap**. The largest artifact observed to deploy
successfully is **~39,869 B**; anything above that is rejected. The raw source size is not the
number that matters — the **compiled artifact** size is, and it is typically much smaller than
the `.py` (a ~72 KB source can compile to ~37 KB).

Consequence: the same contract often **cannot be deployed verbatim** on Bradbury even though
it runs fine on StudioNet.

### How to get ahead of it
1. Measure the compiled artifact size before deploying, not the source size.
2. If you are near or over the cap, strip it down for the deploy artifact: comments,
   docstrings, blank lines, and long string literal wrapping — done mechanically so behaviour
   is byte-for-byte identical. In this repo that is `e2e/minify_contract.py`, which produces
   `intelligent-contracts/proofmark-bradbury.py`.
3. Keep **headroom**. The current build sits at ~36.8 KB against the ~39.87 KB ceiling —
   roughly 3 KB of slack. Every new feature spends from that budget, so re-measure after each
   significant contract change, and treat "it still deploys on StudioNet" as no evidence that
   it will deploy on Bradbury.
4. A blocked deploy still costs gas (one failed attempt here cost ~0.0014 GEN). Budget testnet
   funds accordingly and deploy the minified build first rather than retrying the full one.

### Applicability checklist addition
- [ ] Is the compiled artifact comfortably under ~39,869 B?
- [ ] If not, is there a mechanical minify step producing a deploy artifact **from** the
      canonical source, so the two cannot drift?
- [ ] Was the minified artifact itself tested, not just the full source?

---

## Reference implementation
The fixed rail lives in this repo:
- `intelligent-contracts/proofmark.py` — `_EoaPay` stub, `_reject_payable`, `get_rejection`,
  `get_accounting`, and the two-phase `file_claim` / `judge_claim` split.
- `genlayer-eoa-payout-path.md` (this folder) — the longer explainer for Issue 1.
- `e2e/minify_contract.py` + `intelligent-contracts/proofmark-bradbury.py` — the Issue 4
  deploy artifact and how it is produced.
