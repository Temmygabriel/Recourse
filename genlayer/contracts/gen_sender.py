# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
GenSender — a one-purpose funding tool.

Attach GEN to a call and it forwards exactly that amount to any address you
name. Nothing is retained between calls, so there is no pool to drain and no
ledger to reconcile: money in equals money out, in the same transaction.

This exists because our deploy account holds no GEN on studio-dev and needs
some. See docs/GEN_SENDER.md.

--------------------------------------------------------------------------
WHY THIS IS NOT THE OBVIOUS IMPLEMENTATION
--------------------------------------------------------------------------
A plain wallet (an externally-owned account) has **no intelligent contract
deployed at it**. So this is WRONG and fails silently:

    gl.get_contract_at(target).emit_transfer(value=u256(amount))   # ❌

That compiles to an IC->IC PostMessage. An empty address cannot receive one:
the child transfer errors, this contract's ledger is already debited, the
wallet is never credited -- and **the parent transaction still reports
success**. Nothing in a happy-path test catches it.

The `_EoaPay` stub below compiles to an **EthSend** instead, which credits a
chain-layer EOA normally. This is the fix proven live in
`genlayer-known-money-rails-issues.md` (Issue 1).
"""

from genlayer import *


@gl.evm.contract_interface
class _EoaPay:
    class View:
        pass

    class Write:
        pass


class GenSender(gl.Contract):
    @gl.public.write.payable
    def send(self, to: str) -> str:
        """Forward the value attached to this call to `to`.

        `to` is a 0x-prefixed address. The amount is whatever GEN you attach
        to the call -- this method cannot move anything the contract already
        holds, so there is no way to drain it.
        """
        amount = int(gl.message.value)

        if amount <= 0:
            # NEVER raise from a payable method. On GenLayer a revert does not
            # refund the attached value -- the contract keeps it with no ledger
            # entry (money-rails Issue 2). Returning normally is the safe path.
            return "no value attached — attach GEN to this call and it will be forwarded"

        _EoaPay(Address(to)).emit_transfer(value=u256(amount))
        return f"forwarded {amount} atto to {to}"

    @gl.public.view
    def ping(self) -> str:
        """Trivial liveness check."""
        return "GenSender ready — attach GEN and name a recipient"
