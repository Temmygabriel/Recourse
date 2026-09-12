# Deploying a GenLayer contract to studio-dev — the two failures nobody names

**Audience:** anyone (human or agent) who has a GenLayer intelligent contract
that *looks* correct and will not deploy to **studio-dev**. Written from a real
debugging session on 2026-09-11 that took several attempts across two days and
produced two misdiagnoses before the real causes turned up.

**Scope:** this file is self-contained. You do not need to know anything about
the project it came from.

**If you have one of these two errors, skip to the matching section:**

| You see | Cause | Jump to |
|:--|:--|:--|
| `Could not load contract schema` | Contract is written against the **v0.2.x** SDK surface; studio-dev only serves **v0.3.0** | [§2](#2-failure-a--could-not-load-contract-schema) |
| `FeeValueMustBeNonZero(1)` on a deploy that *did* pass a `--fee-value` | The fee **distribution** is default/empty. The value was never the problem | [§3](#3-failure-b--feevaluemustbenonzero1) |
| `FINALIZED` but `result_name: NO_MAJORITY`, `votes_committed: 0`, `activator: ''` | Usually the same as Failure B — a fee that could not be paid. **Not** a dead network | [§3.3](#33-the-no_majority-trap-it-looks-like-a-dead-network) |

---

## 0. The headline

Two independent things are wrong with the "obvious" approach, and **fixing
either one alone leaves you stuck at the other**:

1. **GenLayer has two incompatible SDK surfaces and the public docs describe the
   wrong one.** Everything on `docs.genlayer.com` — and GenLayer's own
   `write-contract` Claude Code plugin — uses **v0.2.x**. **studio-dev serves
   v0.3.0 only.** A v0.2.x contract fails with a *schema* error, which reads like
   a syntax problem and is really an unresolved-name problem.
2. **`--fee-value` is not a fee setup.** On its own it produces a *default*
   distribution that the FeeManager rejects. You must pass a real
   `distribution` **and** a matching `feeValue`, obtained from
   `genlayer estimate-fees --json`.

---

## 1. Establish ground truth before changing anything

Most of the lost time in the original session came from reasoning about the
wrong SDK version. Do these three checks first; they are cheap and they kill the
expensive hypotheses.

### 1.1 Which SDK surface does the network actually run?

The `Depends` header in the contract's second line selects the py-genlayer
runner. It is the thing that decides which names resolve.

```python
# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
```

| Depends hash | Surface | Served by |
|:--|:--|:--|
| `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` | **v0.3.0** | **studio-dev (61997)** |
| `py-genlayer:1jb45aa8…` | v0.2.x | studionet (61999) |

**The two networks serve different runners.** A contract that deploys on
studionet may fail on studio-dev and vice versa, and the failure will look like
a contract bug. It is not.

**Authoritative source:** `https://sdk.genlayer.com/main/executors/v0.3/`
(path segment `v0.3` matters). `docs.genlayer.com` is **stale** — its pages show
the v0.2.x surface. So does GenLayer's `write-contract` plugin skill.

### 1.2 The v0.2.x → v0.3.0 rename table

| v0.2.x (stale docs) | v0.3.0 (studio-dev) |
|:--|:--|
| `from genlayer import *` | `import genlayer as gl` |
| `gl.Contract` | `gl.contract.Contract` |
| `gl.contract_interface` | `gl.contract.interface` |
| `gl.deploy_contract(…)` | `gl.contract.deploy(…)` |
| `gl.get_contract_at(addr)` | `gl.contract.get_at(addr)` |
| `gl.ContractProxy` | `gl.contract.Proxy` |
| `gl.Event` | `gl.chain.Event` |
| `gl.DynArray` / `gl.Array` / `gl.TreeMap` | `gl.storage.DynArray` / `gl.storage.Array` / `gl.storage.TreeMap` |
| `gl.storage.allow_storage` | `gl.storage.allow` |
| `gl.message_raw` | `gl.message.raw` |
| `gl.advanced.user_error_immediate(…)` | `gl.vm.UserError.immediate(…)` |
| `UserError(msg).message` | `UserError(data).data` |
| `gl.advanced.emit_raw_event(…)` | `gl.chain.Event.emit_raw(…)` |
| `gl.trace(…)` / `gl.trace_time_micro()` | `gl.vm.trace(…)` / `gl.vm.trace_time_micro()` |
| `gl.vm.run_nondet_unsafe(fn, val)` | **`gl.vm.run_nondet(fn, val)`** |
| `gl.vm.run_nondet(fn, val)` | **`gl.vm.run_nondet_default(fn, val)`** |

**☠️ The trap in that last pair.** `gl.vm.run_nondet` **changed meaning**. In
v0.2.x it was the *safe*, sandboxed-validator variant. In v0.3.0 that name
belongs to the **unsafe** variant, and the safe one moved to
`run_nondet_default`. Old code calling `run_nondet` still compiles and still
runs — it just **silently stops validating**.

Migrate by the 1:1 pairing `run_nondet_unsafe → run_nondet`. Do **not**
reflexively map `run_nondet → run_nondet_default`; that is a semantic upgrade
disguised as a rename, and it will change what your contract actually guarantees.

**Also removed in v0.3.0:** the `__on_errored_message__` hook. Do not reintroduce it.

**Not renamed** (these are the same in both): `@gl.public.view`,
`@gl.public.write`, `@gl.public.write.payable`, `gl.nondet.exec_prompt`,
`gl.vm.Return` (`.calldata`), `gl.vm.Result`, `gl.vm.UserError`,
and `@gl.evm.contract_interface`.

**`import genlayer as gl` binds `gl` to the package**, so `gl.contract`,
`gl.vm`, `gl.storage`, `gl.nondet`, `gl.evm`, `gl.message` are top-level
**submodules** of `genlayer` — not attributes on some `gl` object. `gl.Address`,
`gl.u256`, `gl.u32` are package-level type aliases.

### 1.3 Write the SDK stub to fail loudly

If you unit-test contract logic with a stubbed `genlayer` module (a good idea —
it lets you exercise pure helpers with no SDK and no network), **deliberately
omit the old flat names**:

```python
module.contract = types.SimpleNamespace(Contract=_Contract)
module.storage  = _Storage()          # with .TreeMap etc.
module.public   = _Decorator()
module.u32      = _U32
module.vm       = types.SimpleNamespace(UserError=_UserError)
# NOTE: no module.TreeMap, no module.UserError, no module.Contract.
# Old v0.2.x code must fail the import loudly, not pass quietly.
```

A stub that accepts both surfaces will hide exactly the bug that costs you a day.

---

## 2. Failure A — `Could not load contract schema`

### Symptom

The Studio (web UI or CLI) reports:

```
Could not load contract schema
```

This reads like a malformed class declaration. **It is not.** It means a name in
the contract did not resolve under the runner the network selected.

### Diagnosis

Check the `Depends` header first — before touching a single line of contract code.

- Header is `1jb45aa8…` → **you are on v0.2.x and studio-dev cannot run you.**
- Header is missing entirely → also fatal; the runner cannot be selected.

### The control that misleads you (read this one)

An earlier attempt "proved" the contract was innocent like this:

> *"A trivial 12-line contract carrying the same `Depends` header fails
> identically. So the contract is not the problem."*

**That inference is invalid, and it cost a session.** The control shared the
exact defect under test — the same wrong `Depends` header. Two things broken the
same way fail the same way; that is evidence of a **shared cause**, not of
innocence.

**A control must differ from the suspect in the dimension under test.** If you
are testing "is the SDK surface wrong?", the control must carry the *other*
surface. Otherwise it tests nothing.

### Fix

Rewrite to the v0.3.0 surface using the table in §1.2. Do it as a **name-only
rename** first, with no semantic changes, so that a passing test suite afterwards
is real evidence the rename preserved behaviour.

Then verify, in this order:

1. A syntax check that the file imports under a v0.3.0-shaped stub (§1.3).
2. Your existing logic tests still pass.
3. Deploy (§4).

Step 3 is the only one that actually validates the SDK surface. Local checks
cannot — a stub is permissive by construction.

---

## 3. Failure B — `FeeValueMustBeNonZero(1)`

### 3.1 The misleading name

```
Error: Transaction reverted: EVM tx 0x… FeeValueMustBeNonZero(1)
```

Selector `0x632be5a1`. It reads as "you sent no fee." **It does not mean that.**

If you passed `--fee-value 10000000000000000` (0.01 GEN) and still get this, you
have already proven the value is not the problem. Raising it changes nothing.
Raising it to 1 wei changes nothing. The **distribution** is the problem.

### 3.2 What is actually happening

A GenLayer deploy carries a `FeesDistribution` describing how much execution
budget each consensus round gets. `--fee-value` on its own produces a **default**
distribution — all-zero allocations with `rotations: [0]` — and the FeeManager
rejects that outright.

Fix: ask the network for a real one and pass it back **unchanged**.

```bash
genlayer estimate-fees --json
```

Returns something like:

```json
{
  "distribution": {
    "leaderTimeunitsAllocation": "100",
    "validatorTimeunitsAllocation": "200",
    "appealRounds": "0",
    "executionBudgetPerRound": "25000000000000000",
    "executionConsumed": "0",
    "totalMessageFees": "0",
    "rotations": ["3"],
    "maxPriceGenPerTimeUnit": "2",
    "storageFeeMaxGasPrice": "300000000",
    "receiptFeeMaxGasPrice": "300000000"
  },
  "feeValue": "100000000000010352",
  "policy": { "enabled": true, "...": "..." }
}
```

Note the two fields a default distribution gets wrong: **`rotations`** is
`["3"]`, not `["0"]`, and **`executionBudgetPerRound`** is non-zero.

**Strip the `policy` block before passing it** — `estimate-fees` returns it, the
deploy does not accept it.

```bash
# build the payload
genlayer estimate-fees --json 2>/dev/null | grep -o '{"distribution".*' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const j=JSON.parse(s.trim());
      require('fs').writeFileSync('fees.json',
        JSON.stringify({distribution:j.distribution, feeValue:j.feeValue}));
      console.log('ok');});"

# deploy with it
genlayer deploy --contract <your_contract.py> --fees "$(cat fees.json)"
```

### 3.3 The `NO_MAJORITY` trap — it looks like a dead network

A fee failure can surface *later* in the pipeline as:

```
status: FINALIZED
result_name: 'NO_MAJORITY'
num_of_rounds: '0'
votes_committed: '0'
activator: ''
last_leader: ''
```

This looks exactly like "the network is not validating." **It is not.** It is
the signature of a transaction that could not pay its fee, so no validator ever
activated it.

Two things make this misdiagnosis sticky:

- The status says `FINALIZED`, so a status-only check reads as success.
- The fee error is not mentioned in this output at all.

**Rule:** a deploy is successful only if `status_name == 'FINALIZED'` **AND**
`result_name == 'MAJORITY_AGREE'` **AND** `activator` is non-empty. Status alone
is never success.

### 3.4 If the error changes to an execution/out-of-budget error

Then the distribution was accepted but is too small for your contract:

| Revert | Meaning | Fix |
|:--|:--|:--|
| `FeeValueMustBeNonZero(1)` | Distribution is default/empty | Pass a real estimate (§3.2) |
| execution / out-of-budget | Distribution is fine, **`executionBudgetPerRound` too low** | Raise `executionBudgetPerRound` **and** `feeValue` together |

The two errors mean opposite things. Read the revert before reaching for a fix.

---

## 4. The full working sequence

```bash
# --- 0. the CLI must support the target network ---
genlayer --version
# Must be a build whose bundle knows studio-dev / studioDevnet / 61997.
# If `genlayer network list` omits studio-dev, the CLI cannot target it at all:
#   npm install -g genlayer@0.40.0-rc.3

# --- 1. network, account, unlock ---
genlayer network set studio-dev
genlayer account use <funded-account>
genlayer account unlock --account <funded-account> --password <pw>

# --- 2. confirm all three at once ---
genlayer account show
# Expect: the studio-dev RPC, chainId 61997, status 'unlocked', balance > 0.
#
# ⚠️ If a FUNDED account shows balance 0, you are almost certainly reading it
#    against the wrong network (the CLI defaults to studionet 61999). That is a
#    network mismatch, not an empty wallet.

# --- 3. fees ---
genlayer estimate-fees --json          # → distribution + feeValue (+ policy: strip it)

# --- 4. deploy ---
genlayer deploy --contract <your_contract.py> --fees "$(cat fees.json)"

# --- 5. VERIFY — an address printed is not a deploy ---
genlayer receipt <txHash>
# Require: FINALIZED + MAJORITY_AGREE + non-empty activator + 5 votes revealed.
```

### Funding: studio-dev is gasless for EVM gas, **not** for the consensus fee

This one is genuinely counterintuitive and worth stating plainly:

- `eth_getBalance` on the account can read **0** and EVM gas really is free
  (`eth_gasPrice` is `0x0`, `effectiveGasPrice` `0x0` on successful txs).
- **But the GenLayer consensus fee is paid from a real GEN balance.**
- So `0` balance is *not* necessarily fine, and "studio-dev needs no faucet" is
  **false**.

An unfunded account does not produce a clear "insufficient funds" — it produces
the `NO_MAJORITY` signature in §3.3. Fund the account before you debug anything
else.

---

## 5. Dead ends worth skipping

Collected so the next person does not repeat them. Each of these was tried and
is **not** a fix for the two failures above.

| Tried | Outcome |
|:--|:--|
| Stripping all comments from the contract | No effect. The schema error was unresolved names, not comments. (Harmless to try, but not the cause.) |
| Raising `--fee-value` from 1 wei → 0.01 GEN | No effect. The value was never the constraint. |
| Searching for validator activity on the network | Found only our own transactions — because the network is nearly idle, **not** because it is down. A `NO_MAJORITY` tx is not evidence of a broken network. |
| Re-deploying on Bradbury | Different chain, different problem set. Bradbury's RPC load-balances across nodes with unsynchronised mempools (one hash polled three times: `null`, `null`, `FOUND`), and its gas-price arithmetic can strand a tx with no CLI flag to fix it. Not a workaround. |
| Trusting `genlayer trace` | May fail with `gen_dbg_traceTransaction: Method not found` depending on the network. |
| Trusting a studionet success as a control | **Actively misleading** — studionet serves v0.2.x, studio-dev serves v0.3.0. A studionet pass says nothing about studio-dev. |

---

## 6. The method that actually worked

If you take one thing from this file, take the shape of the debugging, not the
specifics:

1. **Get a known-good artefact.** The breakthrough was a *working* example
   contract deployed by hand through the studio-dev web UI. Diffing it against
   ours isolated the `Depends` header and the import style in one step. Prefer
   obtaining one working artefact over reasoning about why something fails.
2. **Diff before you theorise.** A working example and a failing one, side by
   side, beats any amount of reading documentation that may be stale.
3. **Suspect your sources of truth.** The public docs, the official plugin, and
   the previously-successful network were all pointing the wrong way. When a
   *tool* is authoritative (the network accepted contract X and rejected
   contract Y), believe the tool.
4. **Make the failing layer report honestly.** The fee problem hid behind a
   `FINALIZED` status. Read the *execution result*, not the status.
5. **Validate your controls.** A control that shares the suspect's defect proves
   nothing. This was the single most expensive error in the original session.
6. **Re-run commands whose "known failure" is load-bearing.** A recorded
   "`estimate-fees` doesn't work here" was stale, and acting on it delayed the
   fix. Stale negative results are as dangerous as stale docs.

---

## Appendix — what the numbers mean

| Field | Meaning |
|:--|:--|
| `leaderTimeunitsAllocation` | Execution time units granted to the leader |
| `validatorTimeunitsAllocation` | Execution time units granted to each validator |
| `executionBudgetPerRound` | The per-round ceiling; **too low → out-of-budget error, not a fee error** |
| `rotations` | Must match the network's expected rotation set (`["3"]` observed, **not** `["0"]`) |
| `feeValue` | The deposit actually attached to the transaction; must be consistent with the distribution |
| `policy.enabled` | Whether the fee policy is on; `true` on studio-dev as of 2026-09-11 |
| `activator` | The validator that proposed the block. **Empty on a fee-starved tx** |
| `votes_committed` / `votes_revealed` | Should both be 5 on a healthy studio-dev deploy |
