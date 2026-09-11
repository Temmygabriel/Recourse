# GenSender — funding the deploy account on studio-dev

A one-call contract that forwards GEN to any address you name. You deploy it
once in the Studio from your funded account, then call `send` to move GEN to
the account that needs it.

**Why it exists:** the GenLayer CLI's keystore account holds **0 GEN** on
studio-dev, and every deploy from it ends `NO_MAJORITY` with no activator.
studio-dev is gasless for *EVM gas* (`eth_gasPrice` is `0x0`) but the GenLayer
consensus fee is paid from a real balance. See `MEMORY.md` → CRITICAL PATH.

---

## The address that needs funding

```
0xa881365a99d77be904e414ae610e22938bb0466d
```

This is the CLI's own keystore account
(`~/.genlayer/keystores/default.json`). It is not in this repository.

The account that already works is `0x81D6bF84a5b03950d910b4a2F83C68006E0b93f4`
(48.6 GEN on studio-dev) — that is the one to send *from*.

---

## Deploy it

1. Open <https://studio-dev.genlayer.com/>.
2. Paste `genlayer/contracts/gen_sender.py` into the Studio's contract editor.
3. Deploy it, signing with the **funded** account (`0x81D6bF84…`).

> **If the Studio rejects the `Depends` header**, replace the first line with
> whatever the Studio's own "new contract" template puts there. The header pins
> a py-genlayer build; the Studio knows which build it is running and you do
> not. Nothing else in the file depends on it.

---

## Use it

Call `send` with the recipient as the argument, **attaching GEN to the call**:

| method | argument | value attached | result |
|:--|:--|:--|:--|
| `send` | `0xa881365a99d77be904e414ae610e22938bb0466d` | e.g. `2` GEN | forwards exactly `2` GEN to that address |

The contract forwards **exactly what you attach** — it cannot move anything it
already holds, so there is no pool to drain and no reason to guard the method.
A couple of GEN is plenty; the failed deploys cost nothing, since a deposit that
cannot be paid never clears.

Call `ping` if you want to confirm it is live before attaching value.

---

## Verify it actually worked — do not skip this

The whole point of `genlayer-known-money-rails-issues.md` is that **a successful
parent transaction is not evidence that value moved.** After calling `send`:

1. Take the transaction hash and enumerate its **child transactions**. The child
   must be `FINALIZED`, `contract` = GenSender, `recipient` = your target EOA,
   and **free of `GenVM Execution ERROR`**.
2. Re-read the balance of `0xa881365a…466d` afterwards:

```bash
curl -s -X POST https://studio-dev.genlayer.com/api \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_getBalance","params":["0xa881365a99d77be904e414ae610e22938bb0466d","latest"],"id":1}'
```

`0x0` means it did not land, whatever the parent transaction said.

3. Then retry the real deploy:

```bash
genlayer network set studio-dev
genlayer deploy --contract genlayer/contracts/recourse_judgment.py \
  --fee-value 10000000000000000
```

---

## Why `get_contract_at` is not used here

The obvious implementation is wrong for a wallet address and **fails silently**:

```python
gl.get_contract_at(target).emit_transfer(value=u256(amount))   # ❌ WRONG
```

An externally-owned account has no intelligent contract at it, so that compiles
to an IC→IC PostMessage which an empty address cannot receive. The child
transfer errors, the parent reports success, and the money never lands.

`gen_sender.py` uses the `@gl.evm.contract_interface` stub instead, which
compiles to an **EthSend** and credits a chain-layer EOA normally. This is the
Issue 1 fix, proven live in the reference implementation.

It also **never raises** from the payable method. On GenLayer a reverted payable
call does not refund the attached value — the contract retains it with no ledger
entry (Issue 2). A missing value returns a string instead of reverting.
