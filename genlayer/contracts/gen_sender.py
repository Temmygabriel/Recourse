from genlayer import *


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class GenSender(gl.Contract):
    @gl.public.write.payable
    def send(self, recipient: str) -> None:
        v = gl.message.value
        if v == 0:
            raise gl.vm.UserError("attach some GEN to this call")
        _Recipient(Address(recipient)).emit_transfer(value=v)
