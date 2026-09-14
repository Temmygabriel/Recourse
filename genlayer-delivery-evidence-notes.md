# GenLayer escrow with AI-judged delivery — hard-won notes

**Audience:** an engineer or AI assistant building a GenLayer escrow service where
validators judge whether a seller's delivered work conforms to what the buyer was
promised.

**Source:** these notes come from building Proofmark (non-performance coverage for
agent jobs) on GenLayer StudioNet and Bradbury through 2026-09. Everything here was
paid for with real debugging time on a live chain. Where I am uncertain, I say so.

**Read order if you are short on time:** section 3 (test locally, not on-chain) and
section 4 (the payable-value trap). Those two cost the most when missed. Section 1
is the decision that avoids the entire IPFS problem.

---

## 0. The one-paragraph summary

Do not put delivery evidence on IPFS. Put it on GitHub as a **raw URL pinned to a
full 40-character commit SHA**, paired with the **SHA-256 of the exact bytes**. The
trust anchor is the digest, not the host. Make the contract re-fetch the URL and
refuse the deliverable unless the bytes hash to the committed digest. Judge with
validators only in a **separate, non-payable** call, so a failed AI run never has
money attached to it. Test all of it locally in direct mode with mocked web and
mocked LLM, and only then go to a live network.

---

## 1. The evidence decision that saves you months

### What to require from the seller

```
spec_url       = https://raw.githubusercontent.com/<owner>/<repo>/<40-hex-commit>/<path>
spec_sha256    = sha256 of the exact bytes that URL serves
deliverable_url  = same shape, a different commit or path
deliverable_sha256 = sha256 of those bytes
```

### The validation rules that make it safe

Enforce all of these. Each one closes a real hole:

| Rule | Why |
|---|---|
| Must start with `https://raw.githubusercontent.com/` | One allowlisted host you can reason about. A list of IPFS gateways cannot be allowlisted — see section 2. |
| No whitespace, no `?query`, no `#fragment` | Query strings let a URL serve different bytes at different times. |
| Path must be `owner/repo/commit/path...` — at least 4 segments | You are parsing structure, not trusting it. |
| The commit segment must be **exactly 40 lowercase hex characters** | A branch or tag (`main`, `v1.2`) is *mutable*. Someone can force-push and the "evidence" changes after the fact. A commit SHA cannot change. **Refuse branches outright** — this is the single most important rule. |
| `sha256` must be exactly 64 lowercase hex | Otherwise you are comparing garbage to garbage. |
| Both URL length cap and file-size cap | See section 6. |

### The contract must re-verify, not trust

The seller supplies the digest, but the **contract re-fetches the URL itself** and
recomputes the hash before accepting the deliverable:

```
fetched = fetch(url)                     # inside the contract, nondeterministic block
if sha256(fetched.bytes) != claimed_digest:
    reject                                  # fails on the SELLER's transaction
```

This matters for who eats the failure. If you only check the digest at judge time,
a dead or doctored link becomes the *buyer's* problem during a claim. Checking at
submission time means the seller's own transaction fails and they fix it themselves.

### Why the digest, not the URL, is the trust anchor

The URL only says *where to look*. The digest says *what must be there*. Given the
digest, any host that returns those bytes is equally fine, and a host that returns
anything else is automatically rejected. This is why one allowlisted host is not a
trust compromise — availability is the only thing you are betting on it, and section
2 explains what an availability failure actually costs (time, not money).

---

## 2. Why IPFS burned us — the actual failure chain

We started with IPFS CIDs. It failed for four separate reasons, and only the first
is obvious:

1. **The gateways did not reliably resolve the pinned CIDs from inside GenVM.** The
   contract's fetch returned errors or empty bodies for content the uploader could
   see in a browser. This is the obvious one.

2. **A gateway *list* cannot be allowlisted.** With IPFS you need several gateways
   for redundancy (`w3s.link`, `ipfs.io`, `dweb.link`, …). But every host in that
   list is an arbitrary third party the contract must now fetch from. You cannot
   write a meaningful host allowlist that includes "whatever gateways exist". You
   end up either allowing any host (bad) or hardcoding one (which is exactly the
   single-host trade you were trying to avoid).

3. **The uploader's CIDs were not in a gateway-fetchable form.** The pinning service
   returned S3-style object identifiers and ETags, not a CID that resolves through a
   public gateway. Hours were lost reconciling "we uploaded it" with "the gateway
   cannot see it". If your storage provider gives you an S3 path, you do not have a
   CID, no matter what the dashboard calls it.

4. **The user experience was indefensible.** To submit a deliverable, a normal
   person had to: create a pinning account, upload the file, wait for pinning, copy
   the CID, and paste a `ipfs://` or gateway URL. Our own words at the time: *"if
   it's a nightmare for me the developer to use, imagine what it would be for
   users."* A reviewer or a first-time user will not do this. They will bounce.

**GitHub removes all four.** The seller already has the file in a repo — or can
drag-and-drop it into one in a browser. The commit SHA makes it immutable. The URL
is a normal HTTPS URL anyone can open in a tab to check by eye. And it is a single
host you can allowlist and reason about.

---

## 3. Where to test instead of the nightmare

**This is the section that would have saved us the most time.** Do not iterate
contract logic against a live network. Every cycle there costs minutes, RPC rate
limits, real funds, and a `FINALIZED` receipt that tells you nothing useful.

### Tier 1 — direct mode. Live here.

`pytest` with the `genlayer-test` plugin runs the contract **in memory, in about
30–50 ms**, with no network and no money. This is where you design the judge.

```python
def test_deliverable_bytes_must_match_digest(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/escrow.py")
    direct_vm.sender = direct_alice

    # Mock the evidence fetch: regex on URL -> {status, body}
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com/.*/spec\.md",
        {"status": 200, "body": "the agreed spec text"},
    )
    direct_vm.mock_web(
        r".*raw\.githubusercontent\.com/.*/delivered\.md",
        {"status": 200, "body": "TAMPERED BYTES"},
    )

    # Mock the judge LLM: regex on the prompt -> the model's reply
    direct_vm.mock_llm(r".*Score conformance.*", '{"score": 10, "breach": true}')

    contract.accept_job("job-1")
    contract.submit_deliverable("job-1", url, sha256_of("the real bytes"))
    # ^ this must FAIL, because the served bytes do not hash to the claimed digest
```

Available cheatcodes that matter for an escrow:

| Cheatcode | Use it for |
|---|---|
| `direct_vm.mock_web(regex, {"status": ..., "body": ...})` | Every evidence fetch. Also mock `404`, `500`, empty body, and giant body — see section 6. |
| `direct_vm.mock_llm(regex_on_prompt, reply)` | The judge. Vary the reply to test upheld / rejected / malformed JSON / refusal. |
| `direct_vm.warp("2026-01-01T00:00:00Z")` | **Deadline expiry.** Time-travel instead of sleeping. Essential. |
| `direct_vm.value = n` | Simulate attached value on payable calls. |
| `direct_vm.sender = x` | Roles: seller, buyer, arbitrator, stranger. |
| `direct_vm.prank(addr)` | One-off sender change. |
| `direct_vm.expect_revert("...")` | Assert a revert. |
| `direct_vm.snapshot()` / `.revert(id)` | Replay a scenario from a known state. |
| `direct_vm.deal(addr, wei)` | Set balances. |

**Caveat, stated plainly:** direct mode runs the **leader function only** — it does
**not** exercise validator consensus. So it proves your logic, not your consensus.
That is fine: consensus is a platform property, and the pattern in section 5 is
what makes it safe. Test consensus once, live, at the end.

### Tier 2 — StudioNet, for the real end-to-end run

StudioNet is **gasless** — a zero-balance wallet can move value — which makes it the
right place for a live lifecycle test. Two things to know:

- **The `genlayer` CLI cannot attach value to a write.** Payable calls
  (deposit / escrow / claim-with-bond) must go through a **Node harness on
  `genlayer-js`**, which can pass `value`. Budget for writing one.
- **Pin your CLI version.** StudioNet required CLI `0.37.1`; a newer RC could neither
  deploy nor read there. Check the compatibility matrix for your network before
  blaming your contract.

### Tier 3 — a balance-enforcing network, only when you must

If you need to *prove* a wallet balance actually rose (not just that the pool ledger
moved), you need a network that mirrors balances — Bradbury did, StudioNet did not.
That costs real funds and a size cap (section 8). Do this once, at the end, and only
if a reviewer demands it.

### The rule

> Direct mode for logic. StudioNet for the live lifecycle. Bradbury only for
> balance-enforcement proof. Never debug on a live network.

---

## 4. The five money traps in an escrow-shaped contract

These are the ones that actually lose money. All five bit us.

### Trap 1 — a reverted payable call does not return the money

**This is the big one and it is counter-intuitive.** On GenLayer, if a payable call
reverts, the attached value is **not** refunded to the caller. It stays with the
contract, invisible to the contract's own accounting, visible only as the explorer
balance creeping up. A reviewer found exactly this: a funded `issue_policy` finalized
with `GENVM RESULT: ERROR`, no policy was readable afterward, and the explorer balance
had risen by the attached amount.

**The rule:** in a payable function, **never revert on a condition the caller could
fix.** Instead, refund the full attached value *in the same transaction* and return
normally, recording the reason where it can be read:

```python
def _reject_payable(self, reason: str, job_key: str = "") -> None:
    # return the attached value over the external rail, do NOT revert
    if int(gl.message.value) > 0:
        _EoaPay(gl.message.sender_address).emit_transfer(value=int(gl.message.value))
    self.payable_rejections[f"{sender}:{job_key}"] = reason   # readable via a view
```

Then expose a view (`get_rejection(payer, job_id)`) and show it in the UI. "It
failed silently" and "it failed and told me why, and my money is back" are entirely
different products.

**Why the refund goes over an external rail:** see trap 2.

### Trap 2 — an IC-to-IC transfer cannot pay a wallet

Every one of your counterparties is a plain EOA wallet. The convenient-looking
`gl.get_contract_at(payee).emit_transfer(...)` uses the **IC-to-IC PostMessage rail**,
which an empty/EOA address cannot receive: the transfer child finalizes as
`GenVM Execution ERROR`, the value leaves your contract, and the wallet is never
credited. Our payout "succeeded" on the pool ledger for days while buyers got
nothing.

**The fix:** pay through an external `@gl.evm.contract_interface` handle, which the
runtime turns into an **EthSend**:

```python
@gl.evm.contract_interface
class _EoaPay:
    class View:
        pass

    class Write:
        def emit_transfer(self, value: u256) -> None: ...
```

Use this for **every** money-out site: escrow release, refunds, bond returns,
premium payments. Then verify it live by finding the payout transaction's
**children** and confirming each is FINALIZED with no execution error.

### Trap 3 — free acceptance lets one person drain the pool with two wallets

If accepting a job (or listing an item, or agreeing to deliver) is free, then one
controller running both a buyer wallet and a seller wallet can: open the deal, let
the deadline lapse delivering nothing, trigger the automatic breach, and collect the
payout **out of the shared pool** — a loop that drains other people's capital with no
judgement involved.

**The fix:** make acceptance **payable, with a bond ≥ the exposure**, and pay
breaches out of that forfeited bond, crediting it back to the pool:

```
tier_balance_after = pool_value + bond − payout = pool_value
```

The round becomes value-destroying for the attacker (they lose the premium), so the
loop dies. Write the test that asserts this exact equality — name it something a
reviewer will find, e.g. `test_self_dealing_round_is_value_destroying`.

### Trap 4 — coverage that exceeds what can actually be paid

If a buyer is promised a coverage amount, and LPs can withdraw in the meantime, then
`coverage` can exceed what the pool can settle at claim time. Either guarantee it
(with a locked-exposure ledger that blocks withdrawals against open exposure) or
**disclose the limit explicitly**. Silent is the only wrong answer. Track locked
exposure per tier and refuse withdrawals that would breach it.

### Trap 5 — reputation inflated by deals that never happened

Pending, voided, rejected, and expired deals must not count toward "jobs completed"
or "distinct counterparties". Count at the moment the state actually changes —
typically when the deal is accepted — and roll the counters back on void/expiry.
If you do not, a reviewer will find the inflation and it reads as fake traction.

---

## 5. Judging: split the money from the AI

The single most valuable structural decision. **Never put a payable call and a
nondeterministic call in the same transaction if you can avoid it.**

Split the claim into two:

```
file_claim(job_id)   PAYABLE, DETERMINISTIC
    escrow the anti-spam bond, record the claim as "pending"
    do NOT judge anything

judge_claim(job_id)  NON-PAYABLE, NONDETERMINISTIC
    anyone may call it -- permissionless
    fetch spec + deliverable, run the model, reach validator consensus
    move the money based on the verdict
```

Why this is worth the extra step:

- If the AI call fails (model down, host down, validators disagree), **no value is
  attached** to that transaction. Nothing can be burned by trap 1.
- The judgement is **retryable** by anyone — including a third party — so a
  transient failure cannot strand a claim.
- It cleanly separates "who pays for spam" from "who decides the outcome".

**Make the anti-spam bond real** (a claimant who loses forfeits it) or claims become
free griefing. And **make the second call permissionless** — do not gate it on the
payer, or a stalled claim stays stalled. Prove it live by sending `judge_claim`
from a *different* account than the one that filed.

### Validator consensus: how to think about it

The leader runs your code and produces a result; validators re-derive it and vote.
For a judgement, do not ask validators to trust a score — **ask them to re-derive
it**. Have the validator function recompute from its own fetch and compare within a
tolerance band (`|leader_score − my_score| <= tolerance`), rather than comparing
floats for exact equality. Model outputs are not deterministic across runs.

Give the model a **structured output contract** (a strict JSON shape with a bounded
integer score and a boolean) and reject anything else explicitly. A model that
returns prose instead of JSON should be a defined outcome, not a crash.

---

## 6. Define your evidence policy explicitly

A reviewer will ask this, because "fetch the bytes and judge them" hides several
undefined cases. Decide each one, in writing, in the contract:

| Case | Decide | Suggested |
|---|---|---|
| File larger than the cap | Reject at submission, or truncate? | **Reject.** Truncating silently changes what was judged. |
| Binary / non-UTF-8 bytes | Reject? Judge the prefix? | **Reject as unusable evidence**, with a distinct reason string. Do not decode-and-pray. |
| Malformed text (control chars, lone surrogates) | ? | Reject with a distinct reason. |
| Empty body | ? | Reject — an empty file is not a deliverable. |
| Host unreachable / timeout | Is that a breach? | **No.** That is a *transient* failure: raise a retryable error, leave the state untouched, let anyone retry. Never let an outage be scored as a breach. |
| Digest mismatch | ? | Reject on the **submitter's** transaction (see section 1). |

Two caps, not one, and know which binds:

```
MAX_EVIDENCE_BYTES = 128 * 1024   # what you will fetch
MAX_EVIDENCE_CHARS = 16000        # what you will feed the model  <- usually the
                                  # real limit, and the one people forget
```

A size cap alone does not protect the prompt. Our byte cap was 128 KB while the
character cap that actually bound was 16 000 — if you only check bytes, you will
eventually stuff a megabyte of text into a prompt.

**Never let a network failure look like a verdict.** A timeout must not be judged as
"the seller failed to deliver". Model and host failures are transient; only evidence
that was successfully fetched and successfully compared may move money.

---

## 7. The trap nobody warns you about: line endings

This one is subtle and it *will* bite an escrow judge.

The seller hashes the file **on their machine** and submits that digest. GitHub
stores the blob and serves it back. If the two differ by a byte — and the most common
way is **CRLF vs LF line endings** — the digests will not match, the contract will
refuse a perfectly good deliverable, and nobody will understand why.

On Windows this is not hypothetical; it was a live problem in this repo, solved by
pinning the line endings in `.gitattributes`:

```
*.py  text eol=lf
*.md  text eol=lf
```

**Do this even if you think you do not need it.** Pin the file types your evidence
will use. And in the UI, hash **the bytes the server will actually serve** where you
can, not the bytes on the local disk.

Related: the host must send `Access-Control-Allow-Origin: *` for in-browser hashing
with `crypto.subtle` to work without a proxy. `raw.githubusercontent.com` does.

---

## 8. Tooling gotchas, collected

| Gotcha | Detail |
|---|---|
| CLI cannot attach value | Payable writes need a Node harness on `genlayer-js`. |
| CLI version per network | StudioNet needed `0.37.1`; a studio-dev setup needed `0.40.0-rc.3` **plus explicit `--fees`/`--fee-value`**. Mismatched CLI = deploy and read failures that look like contract bugs. |
| Shared global config | `~/.genlayer/genlayer-config.json` holds **both** the active network and the active account, and it is global. If another process flips it, your next command silently targets the wrong chain. Save, set, restore. |
| Per-transaction size cap | Bradbury rejects large contracts (`BlockPubdataLimitReached`, largest known-good ~39,869 B). A contract over the cap **cannot be deployed there at all** — minification helps, but if the build is still over, it is over. Disclose it rather than hiding it. |
| Rate limits | StudioNet throttles around 60 requests/minute per IP. Fine for a dashboard, not for a batch script. |
| `FINALIZED` ≠ success | Reverts finalize too. Only a validator that **voted `agree`** and reported an execution result tells you what happened. |
| Idle validators report ERROR | An idle validator reports an error **without ever running your code**. Do not count those as failures. |
| Windows line endings in git | See section 7. |

### How to actually read a transaction's outcome

Write a small script that, for a given tx hash, prints each validator's
**mode / vote / execution_result**. You will use it constantly, and it is the only
way to distinguish "the contract reverted" from "the network was quiet". Our version
is `e2e/audit-receipts.mjs` in the Proofmark repo — copy the idea.

---

## 9. Minimum test checklist for an AI-judged escrow

A reviewer will ask for each of these by name. Write them in direct mode first.

**Money safety**
- [ ] A rejected payable call **refunds the attached value in-call** and records the reason (trap 1).
- [ ] Every money-out path goes over the EthSend rail and credits an EOA (trap 2) — verified live by inspecting a payout tx's children.
- [ ] Value conservation: assert **deltas**, not absolute balances, so tests are re-runnable on a used contract. (Our old absolute-balance assertions failed on a second run for reasons that had nothing to do with the code.)
- [ ] Coverage can never exceed the settlement-time payout after withdrawals (trap 4).
- [ ] The self-dealing round is value-destroying / the pool closes whole (trap 3).

**Evidence**
- [ ] Digest mismatch is rejected on the **submitter's** transaction.
- [ ] A branch/tag where a commit SHA is required is refused.
- [ ] Oversized evidence is refused (both caps).
- [ ] Binary / malformed / empty evidence is refused with a distinct reason.
- [ ] Host unreachable is a **transient, retryable** error — never a breach, never a payout.

**Judging**
- [ ] Validator disagreement is handled by the tolerance band, not exact equality.
- [ ] A malformed model reply is a defined outcome.
- [ ] `judge_claim` from a **third-party account** works (permissionless).
- [ ] The anti-spam bond is forfeited on a losing claim and returned on a winning one.

**Lifecycle**
- [ ] The full paid lifecycle: open → fund → accept (bond) → deliver → claim → judge → final state.
- [ ] Reputation counters roll back on void / reject / expire (trap 5).
- [ ] Expiry cannot run while a claim is pending, and there is a way to **rescind a
      pending claim** that returns the bond — otherwise a host outage strands funds.

**Meta**
- [ ] Pin your test dependencies and commit the config (`gltest.config.yaml` or
      equivalent) so the suite reproduces on someone else's machine.

---

## 10. Honest counterpoints — where GitHub + SHA-256 is worse than IPFS

I am not selling you GitHub. It wins for this use case, but here is where it loses,
so you can decide with open eyes:

- **A commit SHA is immutable; a repository is not.** The SHA pins the content, but
  the repo can be deleted, renamed, or made private, and then the URL 404s. IPFS
  content survives as long as *anyone* pins it. So GitHub gives you integrity
  guarantees but not permanence guarantees. For a dispute window of days or weeks
  that is fine; for a decade-long archive it is not.
- **It is one host.** `raw.githubusercontent.com` is a single point of availability.
  IPFS's whole pitch is redundancy. You are trading availability for enforceability
  — a deliberate trade, and worth stating out loud. (If a mirror is later added,
  `cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/<path>` serves the same bytes from the
  same immutable commit; adding it is a contract change and re-deploy.)
- **GitHub is a company, not a neutral protocol.** For a truly adversarial setting
  where neither party should control the evidence host, a neutral or self-hosted
  origin is better. Just make sure it serves stable bytes over plain HTTPS with CORS.
- **Non-developer sellers may not have a repo.** This is the real UX cost. Mitigate
  with clear instructions (GitHub's web uploader is drag-and-drop) or a helper that
  commits on their behalf. It is still far easier than pinning to IPFS.

**The general principle, which survives whatever host you pick:** require
*immutability* (a content-addressed pointer — a commit SHA or a CID) **and**
*integrity* (a digest over the exact served bytes), and then have the contract verify
both itself. The host is an implementation detail; those two properties are not.

---

## 11. Copy-paste starting points

### URL validation shape

```python
EVIDENCE_HOST = "raw.githubusercontent.com"
EVIDENCE_URL_PREFIX = "https://" + EVIDENCE_HOST + "/"
COMMIT_HEX_LEN = 40
SHA256_HEX_LEN = 64

def _canonical_evidence_url(value: str) -> str:
    url = value.strip()
    if not url.startswith(EVIDENCE_URL_PREFIX):
        raise ...                          # wrong host, or http://
    if any(c.isspace() for c in url):
        raise ...
    if "?" in url or "#" in url:
        raise ...                          # mutable query / fragment
    parts = url[len(EVIDENCE_URL_PREFIX):].split("/")
    if len(parts) < 4:
        raise ...                          # need owner/repo/commit/path
    owner, repo, commit, rest = parts[0], parts[1], parts[2], parts[3:]
    if not _valid_owner_repo(owner) or not _valid_owner_repo(repo):
        raise ...
    if len(commit) != COMMIT_HEX_LEN or not all(c in "0123456789abcdef" for c in commit):
        raise ...                          # branches and tags are refused here
    if not any(rest):
        raise ...
    return url
```

### The judging call, structurally

```python
@gl.public.write            # NOT payable -- no value at risk
def judge_claim(self, job_id: str) -> None:
    ...
    def leader_fn() -> dict:
        spec = _fetch_url_verified(spec_url, spec_sha256)          # digest-checked
        work = _fetch_url_verified(deliverable_url, deliverable_sha256)
        score = _score(spec, work)                                  # model call
        return {"score": score, "breach": score < BREACH_THRESHOLD}

    def validator_fn(leaders_res) -> bool:
        mine = leader_fn()                                          # re-derive
        if not leaders_res.is_ok or not isinstance(leaders_res.data, dict):
            return False
        return abs(mine["score"] - leaders_res.data["score"]) <= SCORE_TOLERANCE

    result = gl.vm.run_nondet(leader_fn, validator_fn)
    if not result.is_ok:
        raise ...          # transient: leave state untouched, anyone may retry
    _resolve_claim(job_key, policy, breach=result.data["breach"])
```

### Questions worth asking before you write any code

1. Who is allowed to submit the deliverable, and can anyone else forge that call?
2. Can the buyer and the seller be the same person? (If yes, you have trap 3.)
3. What exactly happens if the evidence host is down for a day?
4. What happens if validators split 50/50?
5. Who pays for a claim that turns out to be wrong, and who pays for spam claims?
6. What prevents a promised coverage from exceeding the money that will actually be
   there at settlement?

If you can answer all six with a mechanism and not a hope, you are ahead of where we
started.

---

## 12. Worked example to copy from

The Proofmark repo is the worked example of everything above:
`intelligent-contracts/proofmark.py` (the contract), `tests/direct/test_proofmark.py`
(direct-mode suite with mocked web + LLM), and `e2e/` (the Node harness for payable
calls on StudioNet, plus an audit script that prints per-validator outcomes).

Read `_canonical_evidence_url`, `_fetch_url_verified`, `_reject_payable`, `file_claim`
and `judge_claim` first. Those five functions are where all the lessons live.
