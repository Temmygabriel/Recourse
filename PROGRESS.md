# PROGRESS.md — Recourse build log

Work log, newest first. For durable decisions and constraints see
[MEMORY.md](./MEMORY.md).

**Deadline: Sept 17, 2026** (submission). Today: Sept 10, 2026.

---

## Status at a glance

| Area | State |
|:--|:--|
| Repo scaffold | 🟡 in progress |
| Base escrow contract | 🔴 not started |
| Escrow tests | 🔴 not started |
| GenLayer judgment contract | 🔴 not started |
| Relayer | 🔴 not started |
| Frontend (7 screens) | 🔴 not started |
| CI (GitHub Actions) | 🔴 not started |
| README / security narrative | 🟡 partly written |
| GitHub push wired up | 🔴 blocked — no `gh` CLI on this machine |
| Vercel deploy | 🔴 not started |

Legend: 🔴 not started · 🟡 in progress · 🟢 done · ⚠️ blocked

---

## 2026-09-10 — Session 1

### Done

- **Read and studied both specs** (`recourse_build_spec.md`,
  `recourse_design_spec.md`) and the GenLayer
  [Consensus v0.6 migration doc](https://docs.genlayer.com/developers/consensus-v06-migration).
  Distilled the v0.6 items that actually change our code into
  [MEMORY.md](./MEMORY.md).
- **Confirmed the GitHub repo is empty** and publicly readable.
- **Confirmed local toolchain gaps:** no `gh`, no `winget`, no Vercel CLI, no
  git credentials. → push and deploy paths still open.
- **Wrote the data model** — [docs/DATA_MODEL.md](./docs/DATA_MODEL.md).
  Fixes field names, bounds, hash formulas, the state machine, and the
  rationale for the `UNDETERMINED` payout policy.
- **Wrote and verified the key generator** — `scripts/gen-wallet.mjs`.
  Pure Node, no dependencies, implements Keccak-256 + secp256k1 address
  derivation. Verified against 4 Keccak vectors, 3 published private-key →
  address vectors, and a multi-block absorb test. **All pass.**
- **Generated the testnet keys** into `.secrets/` (gitignored, confirmed with
  `git check-ignore`).
  - Deployer `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b`
  - Relayer `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037`
- **Wrote `.gitignore`**, **`MEMORY.md`**, **`PROGRESS.md`**.

### Caught and fixed

- **Keccak rotation table was transposed.** The first generated addresses were
  wrong — plausible-looking, self-consistent, and would have sent faucet funds
  to an address nobody holds the key to. Caught by adding published
  private-key → address vectors rather than trusting a smoke test that only
  checked "does the hash change when the input changes". Fixed in
  `scripts/gen-wallet.mjs`; the comment there explains why the array looks like
  a transpose of the published table.

### Decisions made this session

D1–D9 in [MEMORY.md](./MEMORY.md). The ones worth flagging:

- Escrow holds **real Base Sepolia USDC** (user's call).
- Solidity ships with **zero external dependencies** so `forge build` works
  from a clean clone with no submodule fetch.
- **Text on-chain as strings, hashes derived by the contract** — the frontend
  never computes a hash, so it cannot desync from the chain.
- **`UNDETERMINED` pays the seller and returns the bond to the buyer.**
  Reasoning in `docs/DATA_MODEL.md` §6.

### Blocked / needs the user

- **GitHub push.** `gh` is not installed and there is no `winget` on this
  machine. The user believed this was done; it is not. Options are in the
  session notes — easiest is downloading the `gh` MSI directly, or supplying a
  PAT.
- **Faucet funds.** The user offered to source faucet tokens. Needed once the
  escrow address is known: Base Sepolia ETH (gas) + Base Sepolia USDC on the
  deployer `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b`, and Base Sepolia ETH
  on the relayer `0x49B4f09C5894c1C90B0ca9099AF3De0Faf7f3037`.

### Next

1. Write `contracts/src/RecourseEscrow.sol` — full state machine, USDC in/out,
   bond economics, EIP-712 `SettlementDecision` verification, nonce replay
   guard, pause-only admin.
2. Write the Foundry test suite including the attack paths (replay,
   double-settle, bad signature, mismatched hashes, wrong source chain).
3. GitHub Actions CI so the build/test runs on a runner, not this machine.
