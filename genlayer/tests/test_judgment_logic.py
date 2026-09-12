"""Tests for the deterministic logic in the GenLayer judgment contract.

Runnable anywhere with plain CPython — no `genlayer` SDK, no pytest, no network:

    python genlayer/tests/test_judgment_logic.py

WHAT THIS PROVES, AND WHAT IT DOES NOT
    The contract's module-level helpers are pure functions, so they can be
    executed and checked directly. That covers the two places where a bug would
    be expensive and silent:

      1. The hash formulas, against the same vectors the Solidity escrow is held
         to (docs/vectors/hash-vectors.json). These two implementations are the
         only ones that exist, in different languages on different chains, and
         nothing inside either can detect that the other started trimming
         whitespace — the escrow would stay internally consistent while every
         dispute became unjudgeable.
      2. `_clamp`, which is what stops a well-formed but self-contradicting
         model answer from being signed and then rejected by the escrow. The
         last test here is exhaustive over outcomes x criteria patterns and
         asserts the escrow would accept every verdict `_clamp` can produce.

    It does NOT validate SDK API usage — whether `gl.vm.run_nondet` exists
    with that signature, whether the storage annotation style is current, or
    whether the pinned runner hash resolves. The `genlayer` module is stubbed
    here so the logic can run without the SDK, and a stub is by construction
    permissive. A deployment into the Studio is what validates the SDK surface.
"""

import hashlib
import importlib.util
import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / "genlayer" / "contracts" / "recourse_judgment.py"
VECTORS_PATH = ROOT / "docs" / "vectors" / "hash-vectors.json"


# ---------------------------------------------------------------------------
# SDK stub
# ---------------------------------------------------------------------------


def _install_genlayer_stub():
    """Minimal stand-in for the SDK, just enough to import the contract.

    The contract does `import genlayer as gl` (v0.3.0 shape), so the stub must
    mirror that layout: the `gl` namespace holds `contract.Contract` as the base
    class, `public` as a decorator factory, `storage.TreeMap` and `u32` for the
    storage annotations, and `vm.UserError`. The flat `TreeMap`/`u32`/`UserError`
    of the older v0.2.x surface are deliberately NOT provided — if the contract
    ever drifts back to the old names, this stub fails the import loudly rather
    than passing and hiding the regression.
    """
    module = types.ModuleType("genlayer")

    class _Contract:
        pass

    class _Decorator:
        """Accepts both `@gl.public.view` and `@gl.public.view(...)`."""

        def __getattr__(self, _name):
            def decorate(fn=None):
                if fn is None:
                    return lambda f: f
                return fn

            return decorate

    class _UserError(Exception):
        pass

    class _TreeMap:
        def __class_getitem__(cls, _item):
            return cls

    class _U32(int):
        def __class_getitem__(cls, _item):
            return cls

    class _Storage:
        TreeMap = _TreeMap

    # `import genlayer as gl` binds `gl` to the genlayer PACKAGE, so `gl.contract`
    # is the top-level `genlayer.contract` submodule, not a namespace nested under
    # a `gl` attribute. Everything the contract reaches for hangs off the module.
    module.contract = types.SimpleNamespace(Contract=_Contract)
    module.storage = _Storage()
    module.public = _Decorator()
    module.u32 = _U32
    module.nondet = types.SimpleNamespace()
    module.vm = types.SimpleNamespace(UserError=_UserError)

    sys.modules["genlayer"] = module


def _load_contract():
    _install_genlayer_stub()
    spec = importlib.util.spec_from_file_location("recourse_judgment", CONTRACT_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["recourse_judgment"] = mod
    spec.loader.exec_module(mod)
    return mod


judgment = _load_contract()
VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# A model of the escrow's coherence rules
#
# Transcribed from `_checkVerdictCoherence` in contracts/src/RecourseEscrow.sol.
# If that function changes and this does not, the last test below will pass
# while the escrow rejects — so the two are meant to be read side by side.
# ---------------------------------------------------------------------------


def escrow_accepts(outcome: str, refund_bps: int, criteria_met: list) -> bool:
    full = (1 << len(criteria_met)) - 1
    met_bits = 0
    for i, met in enumerate(criteria_met):
        if met:
            met_bits |= 1 << i

    if met_bits & ~full:
        return False

    if outcome == "RELEASE":
        return refund_bps == 0 and met_bits == full
    if outcome == "FULL_REFUND":
        return refund_bps == 10_000 and met_bits != full
    if outcome == "PARTIAL_REFUND":
        return 0 < refund_bps < 10_000 and met_bits != full
    if outcome == "UNDETERMINED":
        return refund_bps == 0
    return False


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def test_string_hash_vectors_match():
    """sha256 over the exact UTF-8 bytes, for every divergence-prone case."""
    for vec in VECTORS["string_sha256"]:
        got = judgment._sha256_hex(vec["text"])
        assert got == vec["sha256"], f"{vec['name']}: {got} != {vec['sha256']}"


@test
def test_rubric_hash_vectors_match():
    """Rubric items joined by a single newline, in order, hashed verbatim."""
    for vec in VECTORS["rubric_sha256"]:
        got = judgment._rubric_hash(vec["rubric"])
        assert got == vec["sha256"], f"{vec['name']}: {got} != {vec['sha256']}"


@test
def test_hashes_are_over_verbatim_bytes():
    """The regression this whole file exists for.

    An earlier version of the contract stripped text before hashing it. The
    escrow commits the stored bytes with no normalisation, so that stripped hash
    could never match, and a promise with a trailing newline — which a textarea
    produces routinely — would have made every dispute unjudgeable.
    """
    trailing = next(v for v in VECTORS["string_sha256"] if v["name"] == "promise_trailing_newline")
    padded = next(
        v for v in VECTORS["string_sha256"] if v["name"] == "promise_leading_and_trailing_spaces"
    )

    assert judgment._sha256_hex(trailing["text"]) != judgment._sha256_hex(trailing["text"].strip())
    assert judgment._sha256_hex(padded["text"]) != judgment._sha256_hex(padded["text"].strip())

    # And the vector itself carries the unstripped digest, not the stripped one.
    assert judgment._sha256_hex(trailing["text"]) == trailing["sha256"]
    assert judgment._sha256_hex(trailing["text"].strip()) != trailing["sha256"]


@test
def test_rubric_join_is_a_single_newline():
    for vec in VECTORS["rubric_sha256"]:
        joined = "\n".join(vec["rubric"])
        assert judgment._sha256_hex(joined) == vec["sha256"]
        # A trailing newline after each item, or no separator at all, gives a
        # different hash — the Solidity side does neither.
        assert judgment._sha256_hex(joined + "\n") != vec["sha256"]
        assert judgment._sha256_hex("".join(vec["rubric"])) != vec["sha256"]


@test
def test_clamp_repair_table():
    """Every row of the table documented above `_clamp`.

    The criteria list is treated as the more specific signal, so where the
    model's `outcome` disagrees with its own `criteria_met`, the refund is
    derived from the criteria rather than from the inconsistent label.
    """
    cases = [
        # (raw, criteria_count, expected outcome, expected bps)
        ({"outcome": "RELEASE", "criteria_met": [True, True, True]}, 3, "RELEASE", 0),
        ({"outcome": "RELEASE", "criteria_met": [True, True, False]}, 3, "PARTIAL_REFUND", 3333),
        ({"outcome": "RELEASE", "criteria_met": [False, False, False]}, 3, "PARTIAL_REFUND", 9999),
        ({"outcome": "PARTIAL_REFUND", "criteria_met": [True, True, True]}, 3, "UNDETERMINED", 0),
        ({"outcome": "PARTIAL_REFUND", "criteria_met": [False, False, False]}, 3, "FULL_REFUND", 10_000),
        ({"outcome": "PARTIAL_REFUND", "criteria_met": [True, True, False]}, 3, "PARTIAL_REFUND", 3333),
        (
            {"outcome": "PARTIAL_REFUND", "refund_bps": 2_000, "criteria_met": [True, True, False]},
            3,
            "PARTIAL_REFUND",
            2_000,
        ),
        # A model that names the right outcome but supplies no usable number
        # must get the share derived from its own criteria list, not clamped up
        # from zero to a single basis point.
        ({"outcome": "PARTIAL_REFUND", "criteria_met": [True, True, False]}, 3, "PARTIAL_REFUND", 3333),
        (
            {"outcome": "PARTIAL_REFUND", "refund_bps": 0, "criteria_met": [True, True, False]},
            3,
            "PARTIAL_REFUND",
            3333,
        ),
        (
            {"outcome": "PARTIAL_REFUND", "refund_bps": True, "criteria_met": [True, True, False]},
            3,
            "PARTIAL_REFUND",
            3333,
        ),
        ({"outcome": "FULL_REFUND", "criteria_met": [True, True, True]}, 3, "UNDETERMINED", 0),
        ({"outcome": "FULL_REFUND", "criteria_met": [True, False, False]}, 3, "FULL_REFUND", 10_000),
        ({"outcome": "NONSENSE", "criteria_met": [True, False, False]}, 3, "UNDETERMINED", 0),
    ]

    for raw, count, outcome, bps in cases:
        got = judgment._clamp(raw, count)
        assert got["outcome"] == outcome, f"{raw} -> {got['outcome']}, expected {outcome}"
        assert got["refund_bps"] == bps, f"{raw} -> {got['refund_bps']}, expected {bps}"


@test
def test_clamp_reason_is_never_blank():
    """A blank reason would render as an empty field in the settlement receipt."""
    got = judgment._clamp({"outcome": "RELEASE", "criteria_met": [True, True]}, 2)
    assert got["reason"].strip()

    got = judgment._clamp({"outcome": "RELEASE", "reason": "   "}, 2)
    assert got["reason"].strip()

    long_reason = "x" * 1_000
    got = judgment._clamp({"outcome": "RELEASE", "reason": long_reason}, 2)
    assert len(got["reason"]) <= judgment.MAX_REASON_CHARS


@test
def test_clamp_handles_malformed_input():
    """Anything the model can return must land on a schema, never raise."""
    for raw in [None, "RELEASE", 42, [], {"criteria_met": "yes"}, {"criteria_met": [1, 0, True]}]:
        got = judgment._clamp(raw, 3)
        assert got["outcome"] in judgment.VALID_OUTCOMES
        assert len(got["criteria_met"]) == 3
        assert all(isinstance(m, bool) for m in got["criteria_met"])


@test
def test_clamp_normalises_criteria_count():
    """The model returning the wrong number of entries must not desync the list."""
    got = judgment._clamp({"outcome": "RELEASE", "criteria_met": [True]}, 3)
    assert got["criteria_met"] == [True, False, False]

    got = judgment._clamp({"outcome": "RELEASE", "criteria_met": [True] * 9}, 3)
    assert got["criteria_met"] == [True, True, True]


@test
def test_as_int_rejects_bool():
    """`isinstance(True, int)` is True, so `"refund_bps": true` would become 1bp."""
    assert judgment._as_int(True, 0) == 0
    assert judgment._as_int(False, 7) == 7
    assert judgment._as_int("500", 0) == 500
    assert judgment._as_int(" 500 ", 0) == 500
    assert judgment._as_int(42.9, 0) == 42
    assert judgment._as_int("not a number", 3) == 3
    assert judgment._as_int(None, 5) == 5


@test
def test_proportional_refund_is_bounded():
    assert judgment._proportional_refund(3, 3) == 1  # clamped up from 0
    assert judgment._proportional_refund(3, 0) == 9_999  # clamped down from 10000
    assert judgment._proportional_refund(3, 2) == 3333
    assert judgment._proportional_refund(4, 1) == 7500
    assert judgment._proportional_refund(2, 1) == 5000


@test
def test_clamp_output_always_passes_escrow_coherence():
    """The property that matters: the escrow must accept every verdict we sign.

    Exhaustive over criteria counts and every met/unmet pattern, crossed with
    every outcome the model might name and a spread of refund percentages
    including out-of-range ones. A verdict that reaches Base and is rejected is
    a settlement attempt burnt on a well-formed answer — exactly what `_clamp`
    exists to prevent.
    """
    outcomes = ["RELEASE", "PARTIAL_REFUND", "FULL_REFUND", "UNDETERMINED", "GARBAGE", ""]
    bpss = [0, 1, 2_500, 3_333, 5_000, 9_999, 10_000, 20_000, -5]

    checked = 0
    for count in range(judgment.MIN_CRITERIA, judgment.MAX_CRITERIA + 1):
        for mask in range(1 << count):
            criteria_met = [bool(mask & (1 << i)) for i in range(count)]
            for outcome in outcomes:
                for bps in bpss:
                    verdict = judgment._clamp(
                        {"outcome": outcome, "refund_bps": bps, "criteria_met": criteria_met},
                        count,
                    )
                    assert escrow_accepts(
                        verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"]
                    ), (
                        f"escrow would reject outcome={verdict['outcome']} "
                        f"bps={verdict['refund_bps']} met={verdict['criteria_met']} "
                        f"(from outcome={outcome!r} bps={bps})"
                    )
                    checked += 1

    assert checked > 1_000, f"expected a broad sweep, only checked {checked}"


# ---------------------------------------------------------------------------


def main() -> int:
    failures = []
    for fn in TESTS:
        try:
            fn()
        except AssertionError as exc:
            failures.append((fn.__name__, str(exc)))
            print(f"FAIL  {fn.__name__}\n      {exc}")
        except Exception as exc:  # noqa: BLE001 - report anything, keep going
            failures.append((fn.__name__, repr(exc)))
            print(f"ERROR {fn.__name__}\n      {exc!r}")
        else:
            print(f"ok    {fn.__name__}")

    print()
    if failures:
        print(f"{len(failures)} of {len(TESTS)} failed")
        return 1
    print(f"all {len(TESTS)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
