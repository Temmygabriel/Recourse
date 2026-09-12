# v0.3.0
# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }
import genlayer as gl


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class GenSender(gl.contract.Contract):
    @gl.public.view
    def ping(self) -> str:
        return "ok"

    @gl.public.write.payable
    def send(self, recipient: str) -> None:
        v = gl.message.value
        if v == gl.u256(0):
            return
        _Recipient(gl.Address(recipient)).emit_transfer(value=v)
