# Testing Recourse — step by step

This is a guide for **you**, testing the product by hand. It assumes you have
never opened the app before. Every step says what to click and what you should
see, and the last two sections say what a *failure* looks like and what this
system honestly cannot do.

If you only have ten minutes, do **Part 1, Part 2 and Part 3**. Those cover the
thing that has never been tested and the thing most likely to be broken.

---

## Before you start

You need three things.

**1. The live site.** Either the deployed Vercel URL, or `npm run dev` in
`frontend/` if you are running it locally.

**2. A browser wallet on Base Sepolia.** MetaMask is the easiest. You need the
network added:

| | |
|:--|:--|
| Network name | Base Sepolia |
| RPC URL | `https://sepolia.base.org` |
| Chain ID | `84532` |
| Currency symbol | ETH |
| Block explorer | `https://sepolia.basescan.org` |

**3. Two testnet wallets, loaded into your wallet app.** Recourse always needs
*two* — the seller and the buyer are different people, and the contract refuses
to let you buy your own offer. This project already has both, funded:

| Name | Address | Holds |
|:--|:--|:--|
| **Seller** (`deployer`) | `0xe5Fe9119000C9E1113dc504891A83Da7bbaa7a7b` | ~0.02 ETH, ~23 USDC |
| **Buyer** (`demo`) | `0x0DE10708F8c6DF7b73068d53def715A70C0f340D` | ~0.01 ETH, ~5 USDC |

To import them into MetaMask you need their private keys. They live in
`.secrets/`, which is **gitignored and never committed**. Print each one on your
own machine, import it, and then close the terminal:

```bash
cd "C:/Users/USER/Documents/HACKATHONS BUILDS/RECOURSE"
node -e "console.log(require('./.secrets/deployer.json').privateKey)"   # Seller
node -e "console.log(require('./.secrets/demo.json').privateKey)"       # Buyer
```

> ⚠️ **These are testnet keys with no real value.** Do not paste them into a
> website, a chat, an issue, or a screenshot. Import them into MetaMask and
> nothing else. If they ever leak, the only loss is testnet play money — but the
> habit is the point.

In MetaMask, give them names: **Recourse Seller** and **Recourse Buyer**. You
will switch between them constantly, and "Account 1 / Account 2" gets confusing
fast.

**Have both Brave and MetaMask installed, if you can.** The wallet bug fixed in
Session 14 only shows up when a browser has *two* wallets in it. With one wallet
installed, Part 2 will pass whether or not the fix works — which is exactly why
it is still unverified.

---

## Part 1 — Look around without connecting anything

Reading the app needs no wallet. Everything you see comes from the public
blockchain.

1. Open the site. You land on **Offers**.
2. You should see **seven rows**, one for each purchase that exists:

| # | What it should say | Why it is there |
|:--|:--|:--|
| 1 | **Settled** | The finished one. The money already moved. |
| 2 | **Offer open** | Waiting for a buyer. |
| 3 | **Offer open** | Waiting for a buyer. |
| 4 | **Paid — awaiting delivery** | Bought, seller has not delivered yet. |
| 5 | **Delivered — review window open** | Delivered. This one's window closes Sept 14. |
| 6 | **In dispute** | The buyer says part of it was not kept. |
| 7 | **Delivered — review window open** | Delivered. **This one's window closes Sept 27.** |

3. Click any row. Each one opens a detail page showing the promise, the
   numbered requirements, the price and the deadlines.

**What to look for:** every stage should have a human sentence under it, not a
bare enum. "In dispute" should explain that GenLayer's validators are comparing
the promise against the evidence. If any row shows `NONE`, `undefined`, or a
blank, that is a bug — note the row number.

---

## Part 2 — Connect a wallet (the untested part)

This is the part that has never run in a real browser. Take it slowly.

1. Click **Connect wallet** in the top right.
2. **If you have more than one wallet installed**, a small window should appear
   listing them — for example "MetaMask" and "Brave Wallet". Pick one.
   - **This is the fix.** Before it, the app grabbed whichever wallet happened
     to load last, which could be a completely different one from the one you
     were looking at.
   - If you have only one wallet, no picker appears. That is correct — there is
     nothing to choose between.
3. Your wallet asks for permission to connect. Approve it.
4. **Your wallet should NOT immediately ask to add or switch networks.** It
   should just connect. If a "you could lose funds" or "add network" warning
   appears at this moment, the Session 14 fix has failed — tell me.
5. Your address appears in the header. Hover over it: the tooltip should name
   the wallet it is connected to (e.g. "MetaMask — 0x0DE1…340D"). If you had two
   wallets, that tooltip is how you confirm it picked the one you chose.
6. Above the address is a chip reading **Base Sepolia**. It should be a calm
   neutral colour, not red/contested.
7. Reload the page. It should reconnect without showing the picker again — the
   app remembers your choice.

### If you want to test the wrong-network path

8. In your wallet, switch to Ethereum Mainnet (or any other network) and look at
   the app.
9. A banner should appear: *"Your wallet is on another network…"* with a button
   reading **Switch to Base Sepolia**.
10. Click it. Your wallet should ask to switch, and the banner should disappear.
    - The switch happens **here**, on an explicit button — not during connect.
      That is deliberate: doing it during connect is what produced the scary
      "you could lose funds" dialog on the very first click.

---

## Part 3 — The happy path: accept a delivery (5 minutes)

This is the one to do if you do nothing else. Purchase **#7** is a clean
delivery, sitting and waiting, with a review window open until **Sept 27**.

**Switch your wallet to Recourse Buyer** (`0x0DE10708…`).

1. Open purchase **#7** (logo and brand kit).
2. Read the promise and the three numbered requirements.
3. Read the **delivery notes** — what the seller says they delivered.
4. Find the **Accept** button and click it.
5. Your wallet asks you to confirm a transaction. Confirm it.
6. **Watch the screen immediately after.** It should say something like
   *"Confirmed. Waiting for this page to catch up…"* — this is on purpose:
   Base Sepolia's public RPC can serve a copy of the page that hasn't noticed
   your transaction yet. The app waits for the chain instead of showing you the
   old screen.
7. Once it catches up, the stage should read **Settled**.
8. Open **`/receipt/7`** — it should show the money moving: 3 USDC from the
   buyer to the seller, and no judgment involved (no GenLayer transaction).

**What success looks like:** #7 goes from "Delivered" to "Settled", the seller's
USDC goes up by 3, and the receipt says plainly that no AI decided anything —
because this path never needed one.

### Running low on buyer money?

The buyer starts with ~5 USDC. Accepting #7 costs nothing extra (the money is
already held). Buying things does. If you run out, ask me and I will send more
from the seller wallet or the faucet.

---

## Part 4 — Be the seller: post your own promise

**Switch your wallet to Recourse Seller** (`0xe5Fe9119…`).

1. Click **Post a promise** in the header.
2. Fill it in. There are five fields, and the form enforces the same limits the
   contract does:
   - **What you will deliver** — up to 500 characters.
   - **Price** — in USDC.
   - **Delivery deadline** — when you must deliver by. Must be in the future.
   - **Review window** — how long the *buyer* gets to accept or dispute once you
     deliver. Between 1 hour and 30 days.
   - **Requirements** — **between 2 and 4**, each up to 200 characters, each in
     its own box.
3. Click **Post this promise**.

> **The requirements are the whole product.** They are what a dispute is argued
> against later, and they freeze the moment somebody pays. Write them as things
> a stranger could check. "Delivered a 3-page PDF" is checkable. "Did a good
> job" is not.

**What to look for:** the requirements are **separate boxes**, not one big
textarea. That matters — see the note at the end about the comma bug, which was
mine and not the product's.

---

## Part 5 — The full loop: buy it, deliver it, accept it

Do this with the promise you just posted.

1. **As Buyer**, open your new offer and click **Pay**. Confirm in your wallet.
   - The first time, you will get **two** wallet confirmations: one to approve
     the USDC, one to pay. That is expected — an ERC-20 approval is a separate
     transaction.
   - The app approves the *exact* price, never an unlimited amount.
2. The stage should become **Paid — awaiting delivery**.
3. **Switch to Seller.** Open the offer and click **Submit delivery**.
4. Write what you delivered. The screen seeds a numbered list matching your
   requirements — write to it, one line per requirement.
5. Confirm. The stage becomes **Delivered**.
6. **Switch to Buyer.** Click **Accept**. The stage becomes **Settled**.

You have now run the entire product end to end, in both roles.

---

## Part 6 — Start a dispute and watch GenLayer decide

Purchase **#6** is already sitting in **In dispute** — you can look at it without
spending anything. `/case/6` shows the promise and the evidence side by side.

To run one yourself, you need a purchase in **Delivered** state. Use **#5**
(its window closes Sept 14 — do this today) or deliver one of your own.

1. **As Buyer**, open the delivered purchase.
2. Click **Dispute**. You will be asked **which requirement was not kept** —
   tick the specific ones. You must name at least one.
3. Read the note about the **bond**: 5% of the price, on top of what you already
   paid. If GenLayer agrees with you, it comes back. If it finds the delivery met
   everything, it goes to the seller. This is what stops people disputing out of
   spite.
4. Confirm in your wallet — again two transactions: approve the bond, then open
   the dispute.
5. The stage becomes **In dispute**.
6. Open `/case/<id>`. You should see the promise, the requirements with the
   disputed ones marked, and both sides' written evidence.
7. A verdict takes a few minutes. Watch the row, or check `/verdict/<id>` and
   `/receipt/<id>`.

**What success looks like:** the verdict names how many requirements were met,
the money splits accordingly, and the receipt shows exactly where each part
went — including the bond.

---

## Part 7 — The other pages

- `/case/<id>` — promise vs evidence, both sides' text, after a dispute.
- `/verdict/<id>` — the finding, in one sentence, naming GenLayer.
- `/receipt/<id>` — the money movement. Buyer amount, seller amount, bond.

---

## What "broken" looks like

If you see any of these, stop and tell me which step you were on.

| What you see | What it means |
|:--|:--|
| A "you could lose funds" warning **when you click Connect** | The network-switch fix failed. It should only ever appear if you press the switch button yourself. |
| The picker appears **every reload**, even after you chose | The remembered wallet isn't being saved. |
| You chose MetaMask but the header shows a different address | The wrong-wallet bug is back. |
| Buttons stay stuck on old state after a confirmed transaction, forever | The wait-for-chain fix isn't working — it should catch up within seconds. |
| A row shows **"Not found"** | A cancelled offer. Shouldn't happen unless someone cancelled one. |
| A stage shows a blank or `undefined` | A rendering bug worth reporting. |
| You cannot buy an offer, with an error about the seller | You are connected as the wallet that posted it. Switch accounts. |
| "Insufficient funds" when paying | The buyer wallet is low. Ask me. |

---

## What this system can and cannot prove

This section matters more than the rest, because it is the thing most likely to
be misunderstood — including by a judge.

**The deliverable is text.** Not a file, not a link. The escrow stores one
`deliveryNotes` string, and the delivery screen deliberately has no file picker
and no URL box. A live URL can serve different bytes to different people, so the
form simply has nowhere to put one.

**GenLayer cannot verify that any work was done.** It reads four things — the
promise, the numbered requirements, the seller's delivery notes, and the buyer's
dispute notes — and asks a language model whether the text shows each
requirement was met. It does not open files. It does not check anything against
the real world. **A seller who writes a convincing, detailed, entirely invented
delivery is indistinguishable from a seller who did the work.**

So what does the system actually do?

- It freezes the terms both parties agreed to, before any money moves, and makes
  them impossible to edit afterwards.
- It makes the money follow a **neutral reading of the written record**, rather
  than following whoever is holding it.
- It refuses to accept vague assurances. *"A criterion counts as met only if the
  evidence affirmatively shows it was met. Silence, vagueness, or a bare
  assertion of success is not evidence."*
- It has an honest escape hatch. When the evidence genuinely cannot settle it,
  the outcome is **Undetermined** — the buyer's money comes back and the bond
  returns to the buyer. It is not a trick to avoid deciding; choosing it helps
  neither side.
- It charges the buyer a bond to dispute, so accusing is not free.

**What it does not do is prove reality.** Escrow with an AI judge is
adjudication of what two parties *say*, not verification of what *happened*.
Where the buyer receives the work off-chain — a Figma file, an email, a zip —
the buyer knows the truth and the chain does not. The system's honest claim is
narrow: **the terms cannot be changed after the fact, and neither side gets to
decide their own case.**

If you are writing this up for the submission, that is the sentence to use. The
README and `docs/SECURITY.md` make the same point about the relayer; this is the
same species of honesty about the judge.

---

## Appendix — the comma bug, so you know it was mine

When this project's demo data was first seeded, the rubric text was passed
through the `cast` command line as `[a, b, c]`. `cast` splits that on **every
comma, including commas inside the sentences**. One requirement read *"…all
three pages, each with a desktop and a mobile frame."* — so it was stored as
**two** requirements, with the first cut in half.

That is why purchase **#2** has four requirements where it should have three.
It is frozen on chain and cannot be corrected.

**This cannot happen through the app.** The posting form gives you one box per
requirement, and each box becomes its own value; nothing is ever joined or
split. The bug existed only in a seeding script, which has since been replaced
with `relayer/scripts/seed-demo.ts`.
