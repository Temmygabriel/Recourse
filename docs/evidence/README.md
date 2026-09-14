# Demo evidence artifacts

These are the delivered artifacts the demo purchases point at. They are not
documentation *about* Recourse; they are the bytes the judgment contract
actually fetches when it adjudicates a dispute, and the bytes the artifact
digest is taken over.

## Why they live here

The escrow accepts exactly one shape of delivery URL:

    https://raw.githubusercontent.com/<owner>/<repo>/<40-char-commit>/<path>

A commit SHA is content-addressed, so a URL pinned to one names immutable bytes
forever — the file can be edited, the branch force-pushed, the repo archived,
and this URL still serves this content. That is what makes "the artifact the
buyer paid for" a durable claim rather than a promise about whatever `main`
happens to hold today.

Hosting them in this repository rather than a separate one is deliberate: the
evidence a dispute is decided on is then in the same place as the code that
decides it, and anyone reviewing the project can read both.

## The files

| File                         | Purchase      | Verdict the demo expects                                        |
| ---------------------------- | ------------- | --------------------------------------------------------------- |
| `escrow-review.md`           | e2e run       | **Full or partial refund** — finding 4 carries no severity rating, and the rubric requires one per finding |
| `accessibility-report.md`    | #5            | **Partial** — failures F7 and F11 name a component, not an element |
| `backup-setup.md`            | #6            | **Partial** — the restore drill used a local copy, not a real backup |
| `brand-kit.md`               | #7            | **Release** — a clean delivery, all three criteria met            |

`escrow-review.md` is the one the live end-to-end script delivers
(`relayer/scripts/e2e-live.ts`), which is why it has no seeded purchase number.
The other three are delivered by `relayer/scripts/seed-demo.ts`.

Each was written so that the artifact says what the delivery notes say, and, in
the two disputed cases, so that the shortfall is *visible in the artifact
itself* rather than only asserted by the buyer. That is the property the whole
design turns on: the court reads the work, not a description of the work. A
dispute that could only be won by taking the buyer's word for it would not be
adjudicable from evidence at all.

Note that `accessibility-report.md` and `backup-setup.md` each name their own
shortfall in plain language. That is intentional and it is not a trick — the
seller wrote them, did a genuinely incomplete job, and described it accurately.
Prose that claims more than the artifact shows is exactly what rule 8 in
`recourse_judgment.py` exists to catch.

## Pinning, and what not to do

Do **not** change these files after pinning them. Editing one does not break the
pinned URL — git keeps the old object — but it silently makes the pinned
artifact diverge from the file a reader of this repository sees, which is
confusing in precisely the situation (a live dispute) where clarity matters.

If a demo artifact needs to change, add a new file and a new pin. Do not edit in
place.

The live pins are in `docs/evidence/pins.json`, which also records the SHA-256
of each artifact so a mismatch is detectable without fetching anything.
