Proofmark: GenLayer Project Explorer Submission

Fill-in per genlayer-submission-playbook.md. Anything marked [YOU: ...] is a
blank only you can fill (logo, exact dropdown tags, YouTube link, the live Vercel
URL). Everything else is real and verified: addresses, explorer links, contract
constants, on-chain behavior proven live by the e2e runs, including a judged
claim decided by live validators, and a deterministic payout, both settled on the
canonical contract. Companion files: the demo run-sheet (filming plan) and the
demo caption cards. The video and section 05 describe the same journey.

Date: 2026-09-13. Canonical live Proofmark is FIX-22 on StudioNet
(0x849b576f64ecA308300D278223951E4A88e1B5D4): commit-pinned GitHub URL and
SHA-256 evidence, an agent bond that funds breach payouts, and a live judged
claim. Bradbury carries an earlier minified build (disclosed in the contract
links below).

Repo: https://github.com/Temmygabriel/proofmark (main).

Contract source: intelligent-contracts/proofmark.py (Proofmark, class Proofmark).

01: Identity

Project name: Proofmark

Logo: [YOU: upload the logo image, asset ready: ../branding/proofmark-mark-1024.png (transparent, for the light submission form); ../branding/proofmark-icon-512.png if a square tile is required. SVG and other variants live in ../branding/.]

Primary tag (pick closest in their dropdown): Insurance / Risk

(If the dropdown has an "AI agents" or "AI x Crypto" style tag, prefer that.)

Sub-tag(s) (pick closest, up to 2): DeFi, AI agents

(Choose only tags that exist in their dropdown; adjust at submit time.)

02: One-liner (cap: 180 chars)

Buy insurance on an agent's job: LPs fund risk pools, premiums are
deterministic, and a missed deadline makes the contract itself pay the buyer
from the agent's bond.

(166 characters, fits.)

03: Description (cap: 1000 chars)

Proofmark covers agent work. A buyer backs a job an agent promised to deliver by a deadline; LPs fund per-tier pools, the premium is a fixed percent of coverage, and if nothing is delivered the contract pays the buyer.

Judgment runs on real evidence. A spec is a link to one exact version of a file on GitHub (a 40-character commit id) plus its SHA-256. Only the agent's wallet can attach a deliverable, and the contract re-opens that link, refusing any bytes that do not hash to the commitment. No deliverable by the deadline is a deterministic breach, nothing to game. Otherwise validators re-fetch both files and score conformance.

The mechanics stay honest: the agent posts a bond of at least the coverage when it accepts, and a breach pays the buyer out of that bond, never LP capital. A claim posts a 2 GEN bond, refunded if it holds, forfeited if not. One wallet binds one agent; a job's owner cannot insure it. Reputation is only as strong as the wallet behind it, a real limit.

(988 characters, fits.)

04: Demo video

Pattern (matches the playbook): silent, music only, captions carry it, 60 to 120
seconds. Walkthrough (see the demo run-sheet): an agent registers; an LP funds the
Unrated pool; a buyer backs the job with 1 GEN of cover at a deterministic 0.06
GEN premium against a commit-pinned GitHub spec; the agent accepts, posting a 1
GEN bond; the agent delivers a GitHub file whose SHA-256 the contract re-verifies;
the buyer files a claim with its 2 GEN bond; validator consensus judges the two
files and commits a verdict. On screen: a conforming delivery is DELIVERED, the
claim is rejected and the bond forfeited to the pool; an absent delivery is NOT
DELIVERED, the buyer is paid out of the agent's bond, never LP capital. Two
identities appear on screen (agent window, buyer window); the film maps one to one
to section 05 Steps 2 to 9.

YouTube link: [YOU: paste the link once the edit is done]

05: The reviewer's path (exact steps)

The contract is already deployed, funded, and has finished outcomes on it, a
deterministic payout and a judged verdict. The reviewer uses it; they do not
deploy it. StudioNet is gasless, so a fresh browser wallet can move value
immediately (verified); no faucet.

Why two windows. The contract refuses to insure a job when the buyer is the
agent's own owner (self-dealing guard, a policy must have two independent
parties). So the reviewer plays both roles in two separate identities: a normal
browser window for the agent, a private/incognito window for the counterparty.
Each window auto-generates its own wallet on first load (top-bar chip), so no key
export is needed. Keep them straight: window A = the agent, window B = the
underwriter and buyer.

Evidence is a GitHub file, not an upload. Every spec and deliverable is a
link to one exact version of a file on GitHub, the 40-character commit id, never
a branch, plus the SHA-256 of that file's bytes. The contract accepts only
https://raw.githubusercontent.com/<owner>/<repo>/<40-char-commit>/<path>; it
re-opens the link itself and refuses anything whose bytes do not hash to the
committed SHA-256. The site does the same hash in your browser before you sign,
so you always see the fingerprint you are committing to. The steps below use a
real public pair from this project's own repository, so they are copy-pasteable.

The site opens on a two-panel board. Left is the Coverage pools board: the
capital-utilisation gauge, "{X} GEN backing active jobs", and the four tier bars.
Right is the "Recent activity" feed. Tabs across the top: Agents, Coverage,
Pools, Verdicts. The page foot shows the StudioNet contract
0x849b576f64ecA308300D278223951E4A88e1B5D4, the FIX-22 canonical, where
evidence is a commit-pinned GitHub URL and its SHA-256, and accept_job requires an
agent bond of at least the coverage, so a breach is paid out of the agent's bond
and never out of LP capital.

Step 1: Open the live site in two windows, two identities

Open the live Proofmark site (https://<proofmark-vercel-domain>, [YOU: fill the
live Vercel URL]) in a normal window and again in a private/incognito window.
The board already reads live, funded state: Unrated about 36.24 GEN (about 1 GEN locked
behind a live policy), Bronze 10, Silver 6, Gold 4, and the Recent activity feed
shows the transactions that created it. Nothing is mocked; every number is
on-chain.

Step 2: See finished outcomes already on-chain

Two completed loops sit on this contract right now.

The judged path: verify-job3-studionet-1789320793434. The agent delivered
a commit-pinned GitHub file, the buyer filed a claim, and validators
independently re-fetched both files and scored conformance at 40 or above, so
the claim was rejected, the deliverable conformed. The stamp renders
DELIVERED. Its file_claim (0x14139eec...96edb43d2) and judge_claim
(0x677a4716...ce3f8a00b) are both on the explorer. The policy carries its real
spec and deliverable URLs and SHA-256s, nothing stubbed.

The deterministic path: verify-job-studionet-1789320575300. An agent that
missed its deadline having delivered nothing. No deliverable plus a passed
deadline is a breach the contract declares itself, so there is no AI call and no
evidence to consult (which is why that policy's spec digest is a placeholder):
the claim is upheld and the buyer is paid out of the agent's bond.

Look either up on the Verdicts tab under "Check any verdict", or on the Coverage
tab in the "Job record" panel (paste the job id, click Look up). Keep the tab open.
After your own run in Steps 3 to 8, you will have a third.

Step 3: Register your agent (window A)

In the normal window, on the Agents tab, type an agent id such as
agent-<last4-of-your-address> and click Register agent. The notice confirms;
the profile card shows tier Unrated. One wallet binds to one agent permanently,
so use a fresh id if you retry.

Step 4: Fund a tier pool as the underwriter (window B)

In the private window, on the Pools tab, pick tier Unrated, amount 10, and click
Add capital. The notice confirms the deposit; the Unrated bar grows and the feed
logs the deposit. This capital is the pool's backing, coverage is capped at 10%
of the tier pool when a policy is written. A breach does not drain it: the payout
comes out of the agent's bond, which must be at least the coverage, and the
forfeited bond is credited back to the pool, so the round closes whole.

Step 5: Buy cover on the agent's job (window B)

In the private window, on the Coverage tab, fill the form:

Agent ID: the one you registered in window A

Coverage (GEN): 1

Job ID: job-<timestamp> (fresh, e.g. job-1789...)

Spec: link to the file on GitHub, paste exactly:

https://raw.githubusercontent.com/Temmygabriel/proofmark/2208a0be4503ba6beeb41181876e848ca1a6782f/e2e/evidence/spec.md

The field hashes the file in your browser and shows its SHA-256; it should read
1709a05147f2a78e7c8636be0fa6240c56605dd8361f017e0f509ad4726d9b2b.

Deadline: the current UTC time plus about 5 minutes, in ISO format
YYYY-MM-DDTHH:MM:SSZ (the contract refuses any deadline under 60 seconds, and
anything more than 90 days out).

Click Get quote. The quote box shows the Unrated tier badge and "Premium due
0.06 GEN". Click "Back this job". The notice confirms the job is backed, and the
policy card shows the chip "Pending acceptance", the ball is now in the agent's
court. Refresh the board: the Unrated bar carries a dark sliver, the exposure the
contract has earmarked behind your policy.

Step 6: Accept the job as the agent (window A)

Back in the normal window, on the Coverage tab, paste the same job id into the
"Job record" panel and click Look up. The card shows "Pending acceptance" and an
"Accept job" button, it appears only to the wallet that owns the agent, so if you
do not see it you are in the wrong window. Accepting is now a payable call: the
agent posts a bond of at least the coverage (1 GEN). The chip becomes "Waiting
for delivery". That bond is the money a breach pays out of, LP capital is never
the thing at risk.

Step 7: Deliver, as the agent (window A), the judged path

Still in the normal window, on the Verdicts tab, in the "Submit a deliverable"
panel:

Job ID: the same job

Deliverable: link to the file on GitHub, paste exactly:

https://raw.githubusercontent.com/Temmygabriel/proofmark/2208a0be4503ba6beeb41181876e848ca1a6782f/e2e/evidence/deliverable.md

Its SHA-256 should read
f3ba9374450e7ba312525018febdc7f7dded8d353c1b7c36258f4344f6501860.

Press Check this link first (the panel refuses to submit an unchecked link),
then Submit deliverable. The contract re-opens the URL itself and accepts only
if the served bytes hash to that SHA-256, so a dead or doctored link fails on the
agent's own transaction, not later at the buyer's expense.

Want to see a payout instead of a rejection? Skip this step. With nothing
delivered and the deadline passed, the contract declares the breach
deterministically and the buyer is paid out of the agent's bond, Step 2's
second outcome. Both paths are worth showing; the judged one is the harder.

Step 8: File the claim, let validators judge it (window B)

Back in the private window, on the Verdicts tab, "Request a verdict": enter the job
id and click Request verdict (bond 2 GEN). This is the two-phase claim:

1. file_claim (payable) escrows your 2 GEN bond and records the claim as
pending, it judges nothing.

2. The site then calls judge_claim, a separate, permissionless, non-payable
call. Anyone can trigger it, including a third party. Validators independently
re-fetch the spec and the deliverable and score conformance 0 to 100.

The stamp renders when consensus lands. With the conforming deliverable from
Step 7 the score is 40 or above, so the claim is rejected: the stamp reads
DELIVERED, the agent's bond returns to the agent, and your 2 GEN claim bond is
forfeited to the pool, the cost of a claim that did not hold up. On the
no-deliverable variant the claim is upheld: NOT DELIVERED, the buyer is paid
the coverage out of the agent's bond, and the 2 GEN bond is refunded.

Step 9: Confirm it on-chain

Open the Studio explorer page for the contract (link below) and find the agent,
the deposit, the issue_policy, the accept_job, the submit_deliverable, the
file_claim and the judge_claim for your job, all real finalized transactions,
not mocked state. The finished loops from Step 2 sit on the same contract.

06: Prove the path works, expected overall outcome (cap: 500 chars)

An agent registers on Unrated. A second wallet funds the pool, then buys 1 GEN of cover at a 0.06 GEN premium against a commit-pinned GitHub spec. The agent accepts (posting a 1 GEN bond) and delivers a GitHub file the contract SHA-256-verifies. The buyer files a claim with a 2 GEN bond; it goes pending, then permissionless judge_claim runs validator consensus on both files. Conforming means rejected, bond forfeited. No delivery means upheld, buyer paid from the agent's bond, not LP capital.

What did you change? (cap: 1000 chars)

We changed the evidence model and the economics, then redeployed.

Evidence. A deliverable is now a GitHub link pinned to one exact commit, plus a fingerprint of the file. The contract reopens the link and refuses it unless the bytes match that fingerprint. The old IPFS flow is gone, so a reviewer pastes a normal link.

Economics. Accepting a job is now payable and the agent must stake a bond at least the size of the cover. A breach pays the buyer out of that forfeited bond, and the bond is credited back to the pool, so the pool closes whole and one controller cannot drain LP capital.

Payables. A rejected payable call now refunds the attached value in the same transaction and records why on chain.

Also. Cover can no longer exceed the real payout. Pending policies no longer inflate reputation. Browser keys live in an encrypted keystore. Test dependencies are pinned.

Live. 44 of 44 end to end steps, 19 of 19 payment checks, 74 direct tests, and a judged claim proven on StudioNet.

Contract links (full explorer URLs)

Studio (studionet), canonical live Proofmark (FIX-22), the address the site,
the env, and every harness point at:

https://explorer-studio.genlayer.com/address/0x849b576f64ecA308300D278223951E4A88e1B5D4

Deploy tx 0x1ea533ada62af64d5e85a4a06033bf481fa9a0b25ef25e9a04ac4529f37e6c69

(validators AGREE, CLI 0.37.1). This is the FIX-22 model: commit-pinned GitHub
URL and sha256 evidence, a payable accept_job requiring an agent bond of at least
the coverage (which closes the self-dealing drain), per-buyer/per-agent
open-policy caps, and a 90-day deadline ceiling.

Testnet Bradbury, real validators. Scope stated plainly: Bradbury carries the
earlier PAYOUT-FIX-20 minified build (36,811 B), not FIX-22. The FIX-22
source minifies to about 47.7 KB, roughly 20% over the per-tx pubdata cap, so the
FIX-22 model is proven on StudioNet; Bradbury is kept as a deploy-only
second-network presence (the contract family deploys and read-verifies against
validator-run infrastructure). StudioNet carries the full lifecycle proof.

https://explorer-bradbury.genlayer.com/address/0xE76AF22aea26A84dB11e87FB946060B02F490217

Real finalized transactions on the canonical Studio address page (FIX-22,
2026-09-12/13):

Live e2e: node e2e/run.js e2e --network studionet gives 44/44 steps
(e2e/results/e2e-fix22.log), whose load-bearing line is
pool made whole by the bond (keeps both premiums, pays no LP capital) -- balance=20.1200 GEN,
plus all agent bonds returned (escrow 0). Register, deposit and issue_policy
0x90c7007a..., accept_job with a 1 GEN bond 0x00e50ea4..., file_claim
auto-breach 0xb04b85f9...

Live judged claim: the AI path (e2e/results/verify-payments-fix22-judged2.log,
19/19 checks). file_claim (2 GEN claim bond)
0x14139eec5df00d27b95f8a2e321e8639f6f4ce5516d9dd667b736c496edb43d2
gives get_claim_status = pending. The two-phase split (FIX-19): filing
escrows the bond and records the claim, it does not judge it.

judge_claim: permissionless and non-payable, called here from the LP
account (a third party, to show anyone can trigger judgement)
0x677a4716f2f8276e3572b14c32fae377fbd02c6ac79ef12a51ac6bece3f8a00b
gives verdict rejected, reached by live validators re-fetching a real
commit-pinned GitHub spec and deliverable pair in this repo
(e2e/evidence/spec.md and deliverable.md at commit 2208a0b). The pool received exactly the
forfeited 2 GEN buyer claim bond; the agent's bond returned untouched.

Both txs independently audited (node e2e/audit-receipts.mjs) to
agreeing-validator execution SUCCESS. FINALIZED alone proves nothing.

LP deposit and half-withdraw round trip 0xc9238d70...c02757 and
0xed42b8f0...f1f51c: the pool released exactly the proportional 22.12 GEN
and the tier's locked exposure stayed fully backed (the contract correctly
refuses a withdrawal that would leave live cover unbacked).

07: Send people to it

Live website URL (required): https://<proofmark-vercel-domain> [YOU: fill the live Proofmark Vercel URL]

GitHub repo URL (required): https://github.com/Temmygabriel/proofmark

Pre-flight checklist (playbook Part 2)

Lint/validate clean: genvm-lint check intelligent-contracts/proofmark.py
gives 22 methods (9 view, 13 write).

Deployed on StudioNet: 0x849b576f64ecA308300D278223951E4A88e1B5D4 (FIX-22,
2026-09-12; deploy tx 0x1ea533ad...f37e6c69, validators AGREE, CLI 0.37.1),
the page foot, run.js default, and the deployed frontend all point here.

Deployed on Testnet Bradbury: 0xE76AF22aea26A84dB11e87FB946060B02F490217
(2026-09-08, minified 36,811 B build of the PAYOUT-FIX-20 source;
deploy-only). Disclosed: Bradbury predates FIX-22, the FIX-22 source
minifies to about 47.7 KB, about 20% over the per-tx pubdata cap, so the FIX-22 model
is proven on StudioNet.

Tested live, not just deployed: StudioNet 44/44 e2e steps on the exact
FIX-22 source (register, address-binding revert, deposit, quote, payable
issue including in-call refunds for a rejected and a past-deadline
issuance, agent accept and bond, deliverable submission and foreign-host
refusal, open-policy caps, premature-claim refusal, expiry, auto-breach
payout, LP withdrawal), 19/19 payment checks including the live
judged claim, and 74/74 direct-mode tests. Money rows are asserted as
exact deltas: the pool takes exactly the forfeited claim bond and the
agent bond returns on a rejected claim; a payout leaves as FINALIZED
EthSend transfers to the buyer EOA.

Every remediation on the Project Explorer punch list maps to a named test
in docs/PROOFMARK_REVIEW_REMEDIATION.md (per-item table and section 12 test
matrix). The last live gap (judged claim) closed 2026-09-13.

REMAINING: Frontend live and pointed at the right contract (last manual step): Vercel
env NEXT_PUBLIC_PROOFMARK_CONTRACT_ADDRESS = 0x849b576f64ecA308300D278223951E4A88e1B5D4
set and redeployed; page foot shows that address.

REMAINING: Every section 05 step dry-run against the live site as written
(playbook Part 5).

Sources for every claim

Canonical live address and deploy: 0x849b576f64ecA308300D278223951E4A88e1B5D4
(FIX-22), deploy tx
0x1ea533ada62af64d5e85a4a06033bf481fa9a0b25ef25e9a04ac4529f37e6c69, validators
AGREE, docs/PROOFMARK_LIVE_EVIDENCE.md, docs/PROOFMARK_DEPLOYMENT.md.

Full e2e lifecycle: e2e/results/e2e-fix22.log: 44/44 steps on the exact
FIX-22 source (node e2e/run.js e2e --network studionet), including the
refund-in-call rejections, the foreign-host evidence refusal, the open-policy
caps, and the bond-funded payout line
pool made whole by the bond (keeps both premiums, pays no LP capital) -- balance=20.1200 GEN.

Payments and the judged path: e2e/results/verify-payments-fix22-judged2.log,
19/19 checks. The judged claim is V3 in that log; its two txs are
0x14139eec...96edb43d2 (file_claim) and 0x677a4716...ce3f8a00b (judge_claim),
independently audited to agreeing-validator SUCCESS by
node e2e/audit-receipts.mjs.

Direct-mode suite: python -m pytest tests/direct/ -q gives 74 passed;
genvm-lint check intelligent-contracts/proofmark.py clean (22 methods: 9 view,
13 write).

Every Project Explorer punch-list item, mapped to its fix and its regression
test: docs/PROOFMARK_REVIEW_REMEDIATION.md (per-item table and section 12 test matrix).

Mechanism and constants (premium rates, the agent bond, the 2 GEN claim bond, the
10%-of-tier coverage gate, tier gates, the self-dealing guard, the two-phase
claim, commit-pinned GitHub evidence, the external-EthSend payout rail):
intelligent-contracts/proofmark.py, mirrored in
frontend/lib/proofmarkClient.ts and the live UI; the rail is explained in
genlayer-eoa-payout-path.md.

Honest residue: this StudioNet board has been reused across contract generations
and carries value retained by pre-FIX-21 rejected calls, before the
refund-in-call shape existed. get_accounting(tier) therefore reports both
tier_balance_atto (the ledger) and contract_balance_atto (the chain), so the
difference is inspectable rather than hidden; since FIX-21 no payable call
reverts on a caller-fixable condition, so the gap cannot grow. e2e lifecycle
runs likewise spend down StudioNet pools; seed/demo runs re-fund the board so
reviewers see real, funded pools. Every transaction cited here is real and
finalized on the canonical StudioNet address.
