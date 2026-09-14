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


class FakeResponse:
    """Stands in for `gl.nondet.web.Response(status, headers, body)`."""

    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self.body = body
        self.headers = headers or {}


class FakeNet:
    """The controllable network and model behind the stub.

    Tests assign `FAKE.web` and `FAKE.llm` to plain functions. Both start out
    refusing to answer, so a test that forgets to install a mock fails loudly
    with "no web mock installed" rather than silently judging an empty artifact.
    """

    def __init__(self):
        self.web = lambda url: (_ for _ in ()).throw(
            AssertionError(f"no web mock installed, but the contract fetched {url}")
        )
        self.llm = lambda prompt, response_format="text": (_ for _ in ()).throw(
            AssertionError("no llm mock installed, but the contract called the model")
        )
        self.web_calls = []
        self.llm_calls = []

    def reset(self):
        self.__init__()


FAKE = FakeNet()


def _install_genlayer_stub():
    """Minimal stand-in for the SDK, just enough to import and run the contract.

    The contract does `import genlayer as gl` (v0.3.0 shape), so the stub must
    mirror that layout: `contract.Contract` as the base class, `public` as a
    decorator factory, `storage.TreeMap` and `u32` for the storage annotations,
    `vm.UserError`, `vm.Return`, `vm.run_nondet`, and `nondet.web.get` /
    `nondet.exec_prompt`. The flat `TreeMap`/`u32`/`UserError` of the older
    v0.2.x surface are deliberately NOT provided — if the contract ever drifts
    back to the old names, this stub fails the import loudly rather than passing
    and hiding the regression.

    This is NOT a substitute for the real VM, and the contract's own tests say
    so: the stub is permissive by construction and validates nothing about SDK
    signatures. It exists so the *logic* — the digest check, the fault/transient
    split, the prompt assembly — can be exercised in milliseconds without a
    network or a deployment.
    """
    module = types.ModuleType("genlayer")

    class _Contract:
        """Base class. Storage slots are materialised lazily as plain dicts.

        The real VM builds annotated storage (`TreeMap`, `u32`) from the class
        body at deploy time. Here a dict is enough to exercise the write path,
        and `__getattr__` only runs when normal lookup fails, so a name the
        subclass actually sets is left alone.
        """

        def __getattr__(self, name):
            if name.startswith("__"):
                raise AttributeError(name)
            value = {}
            object.__setattr__(self, name, value)
            return value

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

    class _Return:
        """What the runtime hands a validator: the leader's value, wrapped."""

        def __init__(self, calldata):
            self.calldata = calldata

    class _TreeMap:
        def __class_getitem__(cls, _item):
            return cls

    class _U32(int):
        def __class_getitem__(cls, _item):
            return cls

    class _Storage:
        TreeMap = _TreeMap

    def _web_get(url, *, headers=None):
        FAKE.web_calls.append(url)
        return FAKE.web(url)

    def _exec_prompt(prompt, **config):
        FAKE.llm_calls.append(prompt)
        return FAKE.llm(prompt, config.get("response_format", "text"))

    def _run_nondet(leader_fn, validator_fn):
        """Model the consensus step, single-validator.

        The leader runs, its value is wrapped, and the validator gets its say on
        that wrapper — the same shape direct mode uses. A validator that rejects
        fails the evaluation, which in the real VM reverts the contract and
        leaves state untouched. Raising here is what makes the "an outage must
        not become a verdict" cases testable.
        """
        result = leader_fn()
        if not validator_fn(_Return(result)):
            raise RuntimeError("validators disagreed with the leader")
        return result

    # `import genlayer as gl` binds `gl` to the genlayer PACKAGE, so `gl.contract`
    # is the top-level `genlayer.contract` submodule, not a namespace nested under
    # a `gl` attribute. Everything the contract reaches for hangs off the module.
    module.contract = types.SimpleNamespace(Contract=_Contract)
    module.storage = _Storage()
    module.public = _Decorator()
    module.u32 = _U32
    module.nondet = types.SimpleNamespace(
        web=types.SimpleNamespace(get=_web_get),
        exec_prompt=_exec_prompt,
    )
    module.vm = types.SimpleNamespace(
        UserError=_UserError,
        Return=_Return,
        run_nondet=_run_nondet,
    )

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
# The evidence path: fetch, digest, decode
#
# These are the cases the escrow cannot check and the model must never be asked
# about. Every one of them is a place where a plausible-looking implementation
# hands a decision to a language model that arithmetic should have made, or
# worse, turns an outage into a breach.
# ---------------------------------------------------------------------------

URL = (
    "https://raw.githubusercontent.com/Temmygabriel/recourse-evidence/"
    "8f3c1d90a4b27e56cf0d1a3b8e47f2069cd51a3e/artifacts/article.md"
)

PROMISE = "Write a 900-word article explaining how the escrow holds funds."
RUBRIC = [
    "The article is at least 850 words long.",
    "It names the escrow contract address.",
    "It explains what the relayer does, and states that the relayer is trusted.",
]
DELIVERY_NOTES = "Published the article to the repository at the committed URL."
DISPUTE_NOTES = "Requirement 3 is not met; the article never says the relayer is trusted."

ARTIFACT = (
    "The escrow contract at 0x32288128Ff07Fc9e443161c1F336b784508a056A holds the buyer's "
    "USDC until a verdict arrives. The relayer is a trusted prototype component: it carries "
    "the verdict from GenLayer to Base, and this system is not trustless."
)
ARTIFACT_SHA = judgment._sha256_hex_bytes(ARTIFACT.encode("utf-8"))


def _raises(fn, exc_types, what):
    """Assert `fn()` raises one of `exc_types`. No pytest in this harness."""
    try:
        fn()
    except exc_types:
        return
    except Exception as exc:  # noqa: BLE001 - report the wrong exception clearly
        raise AssertionError(f"{what}: raised {exc!r}, expected {exc_types}") from exc
    raise AssertionError(f"{what}: did not raise")


def _release_reply(prompt, response_format="text"):
    return {
        "outcome": "RELEASE",
        "refund_bps": 0,
        "criteria_met": [True] * len(RUBRIC),
        "reason": "The artifact states each requirement in turn.",
    }


def _judge(body, claimed_hash=None, url=URL, llm=None, status=200):
    """Run `_judge_delivery` once against a fake network and model."""
    FAKE.reset()
    FAKE.web = lambda _url: FakeResponse(status, body)
    FAKE.llm = llm or _release_reply
    return judgment._judge_delivery(
        url,
        ARTIFACT_SHA if claimed_hash is None else claimed_hash,
        PROMISE,
        RUBRIC,
        [2],
        DELIVERY_NOTES,
        DISPUTE_NOTES,
    )


@test
def test_matching_digest_judges_the_artifact():
    """The happy path, and the one that proves the artifact reaches the model."""
    seen = {}

    def llm(prompt, response_format="text"):
        seen["prompt"] = prompt
        return _release_reply(prompt)

    verdict = _judge(ARTIFACT.encode("utf-8"), claimed_hash=ARTIFACT_SHA, llm=llm)

    assert verdict["outcome"] == "RELEASE", verdict
    assert ARTIFACT[:80] in seen["prompt"], "the fetched bytes must reach the model"
    assert escrow_accepts(verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"])


@test
def test_digest_mismatch_is_a_full_refund_and_never_reaches_the_model():
    """THE case this whole design exists for.

    A seller who publishes different bytes than they committed to must lose the
    sale — and the decision must be arithmetic, not a model's opinion. If the
    model were consulted here, a convincing artifact could survive a failed hash
    check, which is exactly the conflation the check exists to prevent.
    """
    body = b"A completely different document that reads very convincingly."
    verdict = _judge(body, claimed_hash=ARTIFACT_SHA)

    assert verdict["outcome"] == "FULL_REFUND", verdict
    assert verdict["refund_bps"] == 10_000, verdict
    assert not any(verdict["criteria_met"]), verdict
    assert FAKE.llm_calls == [], "a tampered artifact must never reach the model"
    assert escrow_accepts(verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"])


@test
def test_a_single_flipped_byte_is_caught():
    """The digest is over bytes, not over meaning — one byte is enough."""
    body = ARTIFACT.encode("utf-8")
    tampered = body[:-1] + bytes([body[-1] ^ 0x01])

    verdict = _judge(tampered, claimed_hash=ARTIFACT_SHA)
    assert verdict["outcome"] == "FULL_REFUND", verdict
    assert FAKE.llm_calls == []


@test
def test_missing_artifact_is_a_full_refund_and_never_reaches_the_model():
    """404 is an answer, not an outage.

    If this were treated as transient, a seller who deleted the repository
    holding the evidence would leave the dispute unjudgeable forever and strand
    the buyer's escrow with no state it could ever reach.
    """
    for status in (404, 410):
        verdict = _judge(b"", claimed_hash=ARTIFACT_SHA, status=status)
        assert verdict["outcome"] == "FULL_REFUND", (status, verdict)
        assert verdict["refund_bps"] == 10_000, verdict
        assert FAKE.llm_calls == [], "a missing artifact must never reach the model"
        assert "could not be retrieved" in verdict["reason"], verdict["reason"]


@test
def test_a_host_outage_is_never_a_verdict():
    """The single most important rule in the evidence policy.

    A 5xx, a timeout, or a DNS failure must fail the evaluation and leave state
    untouched, so the dispute stays retryable. Scoring an outage as a breach
    would let a bad afternoon at GitHub take the seller's money — and scoring it
    as a release would take the buyer's.
    """
    for status in (500, 502, 503, 429):
        _raises(
            lambda s=status: _judge(b"whatever", claimed_hash=ARTIFACT_SHA, status=s),
            judgment.gl.vm.UserError,
            f"HTTP {status} must fail the evaluation rather than decide it",
        )
        assert FAKE.llm_calls == []

    # And a transport-level failure is the same class of thing.
    def _boom(_url):
        raise ConnectionError("connection reset by peer")

    FAKE.reset()
    FAKE.web = _boom
    _raises(
        lambda: judgment._judge_delivery(
            URL, ARTIFACT_SHA, PROMISE, RUBRIC, [2], DELIVERY_NOTES, DISPUTE_NOTES
        ),
        ConnectionError,
        "a transport failure must propagate",
    )


@test
def test_a_raised_404_is_recognised_as_gone_not_as_an_outage():
    """The SDK may raise rather than return a status.

    Whether `NondetException` carries the HTTP status is not something the
    contract can rely on, so the message is inspected. A 404 arriving as an
    exception must still resolve to a refund rather than to an infinite retry.
    """
    def _boom(_url):
        raise RuntimeError("web request failed with status 404")

    FAKE.reset()
    FAKE.web = _boom
    verdict = judgment._judge_delivery(
        URL, ARTIFACT_SHA, PROMISE, RUBRIC, [2], DELIVERY_NOTES, DISPUTE_NOTES
    )
    assert verdict["outcome"] == "FULL_REFUND", verdict
    assert FAKE.llm_calls == []


@test
def test_unusable_artifacts_are_faults_not_outages():
    """Empty, binary, NUL-riddled and oversized are the seller's own bytes.

    Each must produce a refund with a reason naming the rule, and none may reach
    the model — there is nothing to read.
    """
    cases = [
        ("empty body", b"", 0),
        ("PNG magic bytes", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR", 0),
        ("lone NUL", b"looks like text\x00but is not", 0),
        ("over the byte cap", b"x" * (judgment.MAX_EVIDENCE_BYTES + 1), 0),
        ("only whitespace", b"   \n\t  ", 0),
    ]
    for name, body, _ in cases:
        digest = judgment._sha256_hex_bytes(body)
        verdict = _judge(body, claimed_hash=digest)
        assert verdict["outcome"] == "FULL_REFUND", (name, verdict)
        assert verdict["refund_bps"] == 10_000, (name, verdict)
        assert FAKE.llm_calls == [], f"{name} must never reach the model"
        assert "cannot be judged" in verdict["reason"], (name, verdict["reason"])


@test
def test_long_text_is_truncated_loudly_not_rejected():
    """A long article is real work; an unreadable file is not.

    Truncating silently is the thing that changes what was judged without anyone
    being told, so the prompt says so and tells the model not to credit a
    criterion whose evidence would have fallen past the cut.
    """
    long_body = ("word " * (judgment.MAX_EVIDENCE_CHARS)).encode("utf-8")
    assert len(long_body) < judgment.MAX_EVIDENCE_BYTES, "must be under the byte cap"

    seen = {}

    def llm(prompt, response_format="text"):
        seen["prompt"] = prompt
        return _release_reply(prompt)

    verdict = _judge(
        long_body,
        claimed_hash=judgment._sha256_hex_bytes(long_body),
        llm=llm,
    )

    assert verdict["outcome"] == "RELEASE", verdict
    assert "truncated for length, not edited" in seen["prompt"]
    assert "must not be treated as met" in seen["prompt"]


@test
def test_the_artifact_is_fenced_and_the_notes_are_demoted():
    """Prompt assembly: the artifact is evidence, the notes are commentary."""
    seen = {}
    verdict = _judge(
        ARTIFACT.encode("utf-8"),
        llm=lambda prompt, response_format="text": (
            seen.update(prompt=prompt) or _release_reply(prompt)
        ),
    )
    assert verdict["outcome"] == "RELEASE"

    prompt = seen["prompt"]
    assert "THE DELIVERED ARTIFACT" in prompt
    assert "THE SELLER'S DELIVERY NOTES" in prompt
    # Rule 8 is what stops a seller talking their way past an artifact that does
    # not show the work.
    assert "the artifact governs" in prompt
    # Every party-authored block is fenced.
    assert prompt.count("BEGIN_EVIDENCE") == prompt.count("END_EVIDENCE") >= 5


# ---------------------------------------------------------------------------
# URL policy: the judgment layer's own copy of the escrow's rules
# ---------------------------------------------------------------------------


@test
def test_url_policy_matches_the_escrow():
    """Same accept/reject table as `test_Deliver_Rejects*` in the Solidity suite.

    The escrow is the authority, but a package can reach this contract without
    ever having passed through it, so the rules are enforced on both sides and
    the two tables are meant to be read side by side.
    """
    good = [
        URL,
        "https://raw.githubusercontent.com/o/r/" + "a" * 40 + "/f.md",
        "https://raw.githubusercontent.com/o/r/" + "0123456789abcdef" * 2 + "01234567" + "/a/b/c.txt",
    ]
    for url in good:
        judgment._validate_evidence_url(url)

    bad = [
        ("plain http", "http://raw.githubusercontent.com/o/r/" + "a" * 40 + "/f.md"),
        ("wrong host", "https://evil.example.com/o/r/" + "a" * 40 + "/f.md"),
        (
            "host in the path",
            "https://evil.example.com/raw.githubusercontent.com/o/r/" + "a" * 40 + "/f.md",
        ),
        ("branch", "https://raw.githubusercontent.com/o/r/main/f.md"),
        ("tag", "https://raw.githubusercontent.com/o/r/v1.2.3/f.md"),
        ("short commit", "https://raw.githubusercontent.com/o/r/" + "a" * 39 + "/f.md"),
        ("uppercase commit", "https://raw.githubusercontent.com/o/r/" + "A" * 40 + "/f.md"),
        ("non-hex commit", "https://raw.githubusercontent.com/o/r/" + "z" * 40 + "/f.md"),
        ("query", URL + "?v=2"),
        ("fragment", URL + "#top"),
        ("space", URL + " x"),
        ("no path", "https://raw.githubusercontent.com/o/r/" + "a" * 40 + "/"),
        ("no repo", "https://raw.githubusercontent.com/o//" + "a" * 40 + "/f.md"),
        ("empty", ""),
        ("over length", URL + "/" + "p" * 600),
    ]
    for name, url in bad:
        _raises(
            lambda u=url: judgment._validate_evidence_url(u),
            judgment.gl.vm.UserError,
            f"URL should be refused: {name}",
        )


# ---------------------------------------------------------------------------
# The full `evaluate` path
# ---------------------------------------------------------------------------


def _package(**over):
    pkg = {
        "promise_text": PROMISE,
        "promise_hash": judgment._sha256_hex(PROMISE),
        "rubric": RUBRIC,
        "rubric_hash": judgment._rubric_hash(RUBRIC),
        "delivery_notes": DELIVERY_NOTES,
        "delivery_hash": judgment._sha256_hex(DELIVERY_NOTES),
        "dispute_notes": DISPUTE_NOTES,
        "dispute_hash": judgment._sha256_hex(DISPUTE_NOTES),
        "disputed_indices": [2],
        "delivery_url": URL,
        "artifact_hash": ARTIFACT_SHA,
    }
    pkg.update(over)
    return json.dumps(pkg)


def _evaluate(body=ARTIFACT.encode("utf-8"), llm=None, **over):
    FAKE.reset()
    FAKE.web = lambda _url: FakeResponse(200, body)
    FAKE.llm = llm or _release_reply
    return judgment.RecourseJudgment().evaluate("recourse:84532:0xabc:1", _package(**over))


@test
def test_evaluate_end_to_end():
    payload = _evaluate()
    verdict = json.loads(payload)
    assert verdict["outcome"] == "RELEASE", verdict
    assert escrow_accepts(verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"])
    # Canonical form: sorted keys, no incidental whitespace — the relayer hashes
    # these exact bytes for `decisionDigest`.
    assert payload == json.dumps(verdict, sort_keys=True, separators=(",", ":"))


@test
def test_evaluate_rejects_a_malformed_artifact_hash():
    for value in ["", "0x", "zz" * 32, "a" * 63, "a" * 65, "0" * 64, 12345, None]:
        _raises(
            lambda v=value: _evaluate(artifact_hash=v),
            judgment.gl.vm.UserError,
            f"artifact_hash should be refused: {value!r}",
        )


@test
def test_an_uppercase_artifact_hash_is_the_same_digest():
    """Hex case is not information. `_norm_hash` lowercases it, so an uppercase
    digest is the same commitment and must be accepted.

    This is deliberately unlike the URL rule, where an uppercase commit SHA is
    refused: there the string *identifies* the resource to a host that serves
    only one spelling, whereas here it is a value being compared.
    """
    verdict = json.loads(_evaluate(artifact_hash=ARTIFACT_SHA.upper()))
    assert verdict["outcome"] == "RELEASE", verdict

    # And a 0x-prefixed digest is the same value too.
    verdict = json.loads(_evaluate(artifact_hash="0x" + ARTIFACT_SHA))
    assert verdict["outcome"] == "RELEASE", verdict


@test
def test_evaluate_rejects_a_tampered_package():
    """The existing consistency checks still hold, now with the new fields."""
    _raises(
        lambda: _evaluate(delivery_notes=DELIVERY_NOTES + " extra"),
        judgment.gl.vm.UserError,
        "delivery_notes must not match its committed hash after tampering",
    )
    _raises(
        lambda: _evaluate(rubric=RUBRIC + ["An extra criterion."]),
        judgment.gl.vm.UserError,
        "rubric_hash must not match after tampering",
    )
    _raises(
        lambda: _evaluate(disputed_indices=[]),
        judgment.gl.vm.UserError,
        "a dispute must name at least one criterion",
    )


@test
def test_evaluate_fails_when_validators_disagree():
    """A validator that computes a different outcome fails the evaluation.

    The stub runs a single validator, so disagreement is modelled by making the
    model answer differently on the second call — which is exactly what a
    drifting model looks like to the consensus step. The evaluation must fail
    rather than settle on whichever answer came first.
    """
    replies = [
        {"outcome": "RELEASE", "refund_bps": 0, "criteria_met": [True] * 3, "reason": "met"},
        {
            "outcome": "FULL_REFUND",
            "refund_bps": 10_000,
            "criteria_met": [False] * 3,
            "reason": "not met",
        },
    ]
    calls = {"n": 0}

    def llm(prompt, response_format="text"):
        reply = replies[min(calls["n"], 1)]
        calls["n"] += 1
        return reply

    _raises(
        lambda: _evaluate(llm=llm),
        RuntimeError,
        "a validator that disagrees must fail the evaluation",
    )


@test
def test_a_tampered_delivery_settles_as_a_refund_through_the_full_path():
    """End to end: replace the artifact, and the court refunds without a model."""
    FAKE.reset()
    FAKE.web = lambda _url: FakeResponse(200, b"Substituted content, published later.")
    FAKE.llm = _release_reply

    verdict = json.loads(judgment.RecourseJudgment().evaluate("k", _package()))

    assert verdict["outcome"] == "FULL_REFUND", verdict
    assert FAKE.llm_calls == [], "the model must not be consulted on a failed digest"
    assert escrow_accepts(verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"])


@test
def test_every_rejection_is_acceptable_to_the_escrow():
    """A rejection the escrow would refuse is worse than no rejection at all.

    The escrow rejects FULL_REFUND with all criteria met, so a `_reject` that
    left the criteria list empty would burn the settlement instead of refunding
    the buyer.
    """
    for count in (judgment.MIN_CRITERIA, 3, judgment.MAX_CRITERIA):
        verdict = judgment._reject("some reason", count)
        assert escrow_accepts(
            verdict["outcome"], verdict["refund_bps"], verdict["criteria_met"]
        ), (count, verdict)
        assert len(verdict["criteria_met"]) == count
        assert len(verdict["reason"]) <= judgment.MAX_REASON_CHARS


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
