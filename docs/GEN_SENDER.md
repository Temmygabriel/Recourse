# GenSender — funding the deploy account on studio-dev

A one-call contract that forwards GEN to any address you name. You deploy it
once in the Studio from your funded account, then call `send` to move GEN to
the account that needs it.

**Why it exists:** a deploy run from the CLI's original keystore account
(`0xa881365a99d77be904e414ae610e22938bb0466d`) ended `NO_MAJORITY` with no
activator. studio-dev is gasless for *EVM gas* (`eth_gasPrice` is `0x0`) but the
GenLayer **consensus fee is paid from a real GEN balance**, so an unfunded
account cannot get a transaction activated — and the failure does not look like
insufficient funds.

> **Update, 2026-09-11 — this contract is no longer on the critical path.**
> The repo's deployer key was imported into the CLI as the account `deployer`
> (**now active**), so the same wallet that claims the studio-dev faucet in a
> browser is the account the CLI deploys from. Fund that wallet and deploy
> directly; you do not need this contract to move GEN.
>
> Keep this file for what it still teaches: the IC → **EOA** transfer pattern,
> and the rule that a successful parent transaction is not evidence value moved.
> If you are here to unblock a deploy, go to
> [`DEPLOY.md`](./DEPLOY.md) instead.

---

## The addresses

```
fund this →  0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b   (CLI account "deployer", active)
```

This key is **`.secrets/deployer.json`** in the repo — gitignored, testnet only.
Import it into a browser wallet, connect to <https://studio-dev.genlayer.com/>,
and claim the faucet. The CLI then spends from the same account.

The old CLI keystore account `0xa881365a99d77be904e414ae610e22938bb0466d`
(`~/.genlayer/keystores/default.json`) is still there but is **not active** and
its password was never recorded. Do not fund it.

---

## This contract targets the v0.3.0 SDK — that matters

studio-dev runs the **v0.3.0** py-genlayer runner. The API surface was
renamed, and a contract written against the older surface fails with
`Could not load contract schema` — which reads like a syntax problem but is
really an unresolved-name problem.

| | v0.2.x (stale docs) | v0.3.0 (studio-dev) |
|:--|:--|:--|
| header | `1jb45aa8…` | `5jycge4q…` |
| import | `from genlayer import *` | `import genlayer as gl` |
| base class | `gl.Contract` | `gl.contract.Contract` |
| address type | bare `Address` | `gl.Address` |
| get contract | `gl.get_contract_at(a)` | `gl.contract.get_at(a)` |
| IC interface | `@gl.contract_interface` | `@gl.contract.interface` |

`docs.genlayer.com` still shows the left column. `sdk.genlayer.com` (path
`/main/executors/v0.3/`) shows the right column and is the one to trust.
`@gl.evm.contract_interface` is **not** renamed — it stays as-is.

---

## Deploy it

1. Open <https://studio-dev.genlayer.com/>.
2. Paste `genlayer/contracts/gen_sender.py` into the Studio's contract editor.
3. Deploy it, signing with the **funded** account (`0x81D6bF84…`).

The file is self-contained: the runner header on line 2 is required, and the
first line marks the SDK generation. Keep both.

---

## Use it

Call `ping` first — it returns `ok` and costs nothing, confirming the contract
loaded and deployed before you attach any value.

Then call `send` with the recipient as the argument, **attaching GEN to the
call**:

| method | argument | value attached | result |
|:--|:--|:--|:--|
| `ping` | — | none | returns `ok` |
| `send` | `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b` | e.g. `2` GEN | forwards exactly `2` GEN to that address |

The contract forwards **exactly what you attach** — it cannot move anything it
already holds, so there is no pool to drain and no reason to guard the method.
A couple of GEN is plenty; the failed deploys cost nothing, since a deposit that
cannot be paid never clears.

Calling `send` with no value attached returns quietly rather than reverting. On
GenLayer a reverted payable call does not refund the attached value — the
contract retains it with no ledger entry. Never revert a payable call on
caller-fixable input.

---

## Verify it actually worked — do not skip this

The whole point of `genlayer-known-money-rails-issues.md` is that **a successful
parent transaction is not evidence that value moved.** After calling `send`:

1. Take the transaction hash and enumerate its **child transactions**. The child
   must be `FINALIZED`, `contract` = GenSender, `recipient` = your target EOA,
   and **free of `GenVM Execution ERROR`**.
2. Re-read the balance of the recipient afterwards:

```bash
curl -s -X POST https://studio-dev.genlayer.com/api \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b","latest"],"id":1}'
```

`0x0` means it did not land, whatever the parent transaction said.

3. Then retry the real deploy **as the funded account**:

```bash
genlayer account use deployer        # confirm the active account is the funded one
genlayer account show                # prints address + balance — balance must be non-zero
genlayer network set studio-dev
genlayer deploy --contract genlayer/contracts/recourse_judgment.py \
  --fee-value 10000000000000000
```

**Check `account show` before every deploy.** The `default` account and the
`deployer` account both exist in the CLI; deploying from the wrong one reproduces
the original `NO_MAJORITY` failure exactly.

---

## Why `emit_transfer` goes through `@gl.evm.contract_interface`

The obvious implementation is wrong for a wallet address and **fails silently**:

```python
gl.contract.get_at(target).emit_transfer(value)   # ❌ WRONG for an EOA
```

An externally-owned account has no intelligent contract at it, so that compiles
to an IC→IC `PostMessage` which an empty address cannot receive. The child
transfer errors, the parent reports success, and the money never lands.

Targeting the EOA through the **EVM** interface instead compiles to an
`EthSend`, which credits a chain-layer EOA normally. This is GenLayer's own
documented pattern for paying an EOA, and it is the Issue 1 fix. External
messages can only be emitted `on='finalized'`; that is the default, so the
contract does not pass it.
