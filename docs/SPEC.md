# GreedyGoose spec

The product rules for v2, in one place. Where this file and `CLAUDE.md`, `docs/PARKED.md` or `docs/JUSTALAB-DECISIONS.md`
disagree, this file wins. The decisions log stays as the record of why each rule exists.

- Design reference: the GreedyGoose canvases (core boards; the Repay + free up canvas, boards 1–14). The coded UI matches
  them. A rule below wins over a board when they disagree (for example, no stock APY).
- Build plan: the GreedyGoose v2 build plan (Claude Doc), milestones V0–V5.
- Code layout and conventions: [ARCHITECTURE.md](ARCHITECTURE.md).

Rules marked **(to build)** are decided but not in the code yet.

## The product

An invest-and-earn app on Base, signed in with a JAW passkey.

- **Cash** always earns: it is the Aave V3 savings balance plus the wallet's USDC, shown as one pot. Buys and repays
  take from savings inside the same signature.
- **Stocks** are the 7 Coinbase tokenized stocks (Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla). They earn
  no yield, so no stock shows an APY. "Not company shares" appears once, on the stock sheet.
- **Credit** is USDC on the Aave V4 Equities spoke, backed by the user's stocks.
- **Agents** run on-chain in `GooseExecutor`, triggered by Chainlink Automation. There is no server and no database:
  the app reads everything from Base, and the price route is stateless.

## Home

- Quick actions: Top up, Trade, Credit Buy, Repay.
- The menu: Activity, Guide (Coming soon, at /guide) and Settings.
- Activity also lists money and stocks someone else sent ("Received …"), read from USDC's and the stocks' Transfer logs
  to the account, a week at a time with Show earlier, back to the app's first block (2026-09-18). Received money is
  money put in, not profit. Scanned blocks are kept on the phone. It needs an RPC that answers getLogs: Base's public
  one refuses them, so it stays off until NEXT_PUBLIC_BASE_RPC_URL is set. The Cash sheet's "Received" rows (the last 7
  days) wait for the same: until then it lists the user's own moves alone, with no "couldn’t load" notice.
- A tap on the name in the header copies it ("sam.justan.id"), with a toast.
- Under the total balance, all-time P&L once it can be added up (Adrian, 2026-10-19): "+$142.84 · +7.14% all time",
  and the line under it is that P&L at each day's end since the first money in, from $0 (a dashed line) to now. P&L
  is worth now (cash + stocks at Aave's price − credit owed) + what was sent out − what was put in: money and stocks
  someone sent, and other coins turned into cash, are put in, not profit. Stocks that moved count at Aave's price at
  that block. The % is the gain over the average money in, each flow weighted by how long it was in (Modified Dietz).
  Money others sent comes from Alchemy's Transfers API (Base's public RPC refuses getLogs, Etherscan's free plan has no
  Base), so until NEXT_PUBLIC_ALCHEMY_KEY is set Home shows today's change and the week's line as before. Past days
  and transfers are kept on the phone. The Leaderboard's % is to move to the same method.
- The Yield card: the cash rate as its tag ("4.0% APY ⓘ"; VARIABLE sits in the Average yield sheet) and, big, what the
  cash has earned in savings, "Earned all time", counting up live with a green dot while it earns (Adrian, 2026-10-18).
  One size for the whole number, one digit past the digit that moves each second. It is Aave V3's own number: the
  `balanceIncrease` of each aUSDC Mint and Burn of the account (one per savings move, read from the receipts of its JAW
  batches and kept on the phone), plus what built up since the last move (balance less the balance at that move's
  index). Between reads it carries on at the live rate on the savings, so less cash counts slower and no savings holds
  still; each read restarts it and it never steps back. With nothing earned and nothing saved: "Not earning yet".
- The Average yield sheet opens on the earnings by period: Week, Month, Year or All (the default). Each shows what was
  earned in it (live), what savings held on average over it, and over how long; a period longer than the savings
  starts at the first money in and says since when. Between two moves the balance holds still and its interest comes
  in evenly, so a period that cuts a stretch counts its share by time. A move's money in and out comes from the pool's
  Supply and Withdraw in the same receipt. Moves the Cash Agent makes are not in JAW's history, so the totals leave them
  out until it ships.

## Credit health

| Band  | Health factor | What happens                                         |
| ----- | ------------- | ---------------------------------------------------- |
| Safe  | 1.5 and above | Nothing                                              |
| Watch | 1.1 to 1.5    | Allowed. Ending in Watch asks for one tick           |
| Act   | under 1.1     | Protect steps in. Nothing the user does may end here |

- **1.12 is the line.** Taking credit and freeing stock never end below 1.12 (Act line + 0.02). There is no other cap
  on leverage.
- **Aave's own check runs before JAW's sheet.** Every batch that takes credit or frees stock is simulated on Base with
  the health read after it; a result under 1.10 stops it.
- **Protect** acts only in Act. It repays from cash first, sells backing stock only if cash can't, and brings the
  credit back to 1.20. It never acts in Safe or Watch and never sells on a weekend.
- On Home, Credit's ⓘ opens "My credit status", on Aave's rules: the health and how far the stocks can fall, all
  together, before Aave's line (1.0) and before Act (1 − line ÷ health); how it's worked out (each stock that backs
  credit counts its value × the share Aave counts, together ÷ what's owed); and the scale: Safe, Watch, Act and Aave's
  line, each with where it starts and what happens there. The owed amount opens the Credit sheet.

## Money rules

- **Fuel tank:** $0.10 of cash stays back for network fees; every spend from cash leaves it. Buying power is cash minus
  the fuel tank, in cents. Settings shows how full it is. No screen of ours lists the network fee: JAW's sheet shows
  it.
- **The Cash sheet splits the cash** into My cash, From credit (credit backed by stocks that came in as cash: Earn
  with stocks, or credit taken alone) and the fuel tank. Nothing on chain says which dollars are credit, so the rule
  is a convention: credit that came in as cash adds to it, a repay pays it back first, and it is never more than
  what's owed or the cash after the fuel tank.
- **No minimums of ours.** Only Aave's and Base's own limits apply, plus the $0.01 arrivals filter.
- **No dust.** Sell all or Max leaves nothing; a sale that would leave under $1 sells everything.
- **Swaps are held to Aave's price, in the batch itself.** A sale's minimum is the larger of the quote less 1% and the
  shares at Aave's price less 10%; a buy's minimum is the larger of the quote less 1% and the shares the dollars buy
  at Aave's price plus 10%. So no swap fills more than 10% off Aave's price, even when the quote sits at the limit.
- **Approvals are exact and never left open.** Every approve is for the exact amount the next call spends (nothing
  unlimited passes the allowlist), and every repay ends by setting the allowance back to 0, since a repay can be more
  than is owed by the time it lands (Protect repaid meanwhile).
- **A sale into cash earns at once** (Adrian, 2026-10-18): Sell and Trade's stock → cash put what the sale is sure to
  bring (the swap's floor) straight into savings, in the same signature. The wallet keeps only what it lacks of the
  fuel tank; what the pool pays over the floor stays in the wallet. A repay by selling and stock → stock don't save.
  Activity shows the sale alone: savings are the same cash.
- **One stock order** in every list: Home's (Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla). Lists keep
  their groups (what can go before what can't); a default still opens on the cash or the biggest free stock.

## Credit Buy (canvas boards 30–34)

- The stock to buy lists the other stocks first, then My holdings. MAX fills the most to the cent, rounded down.
- Step 1: **Credit ready** first (the credit left on what already backs credit; nothing new goes in), then **Back new
  credit with** each stock and what it backs on its own ("Up to $417"). Then the stock to buy, then the amount. The
  stock to buy is always chosen on that list, even when Credit Buy opens from a stock's sheet: a stock put in use buys
  any stock (Adrian, 2026-10-19).
- No "how much to put in" step: only what the buy needs goes in, enough of the picked stock for the buy to stay Safe on
  its own, or all of it (then it may end in Watch, with the tick). The amount says "Backed by 1.16 Apple · $290".
- The amount step shows how far the buy moves the credit: the bar from now to after, and "Safe → Watch" when it changes.
  Credit ready only lowers health; new backing moves it toward Safe.

## Repay (canvas boards 1–8)

- One sheet over the page: Pay with (cash or a stock) and the amount, then "Free up stocks", open from the start
  (Adrian, 2026-10-19): each stock that backs credit says what can come out now, with no repay when the credit allows
  it; repaying first frees more. "Clear" takes every tick off. The button reads Repay, Free up, or Repay & free up.
- Ticked stocks share one limit that stops at 1.12. A chip shows the % of the shares held (25%, 50%, Max, All); the
  line under the stock shows the shares, "0.60 of 2.40 shares". All carries a padlock until the repay covers it.
- Repay and free up go in one signature: repay first, then take each ticked stock out.
- The amount opens at 0. **Repay all** (All, or typing what's owed) repays every cent and returns every stock, in one
  signature: clearing the debt always frees every stock, with no option to keep any backing.
- Paying with a stock that backs credit can go to Aave's own limit (less 0.5%), because the debt drops in the same
  signature.

## Stocks that back credit (canvas boards 9–11)

Sell, Trade and Send move **free shares only**. MAX is every free share; more than that says "That’s more than your
free shares." Shares that back credit come back with a repay first (Repay, Free up shares); none of the three takes
them out of backing. Amounts are in dollars, with one line under them: "0.87 shares · $230.41 each" and "Up to $373",
the free shares' value. A stock whose shares all back credit is listed but can't be picked, and says so.

## Leaderboard

- Return counts on the user's own money only, so winning with credit lifts the rank.
- While it opens soon, there are no All | Contacts tabs.
- **Greedy Fatalities (to build, once its boards are checked):** every liquidated account is named automatically on its own tab, ranked by its multiple at the
  end. The rule is stated once before the first credit.
- Leverage tag: "1.7x" (what you hold ÷ your own money), a small chip in Home's header while something is owed;
  tapping it opens "My leverage". On leaderboard rows **(to build, once its boards are checked)**. No greed points or
  levels.

## Agents

- Visible: **Protect** and **Rebalance**, on the Agents tab. Under them, **DCA**, **Auto top up** and **JAW MCP** show as
  Coming soon, with nothing to open yet.
- Invisible: earning on idle cash (Save) and turning other dollars into cash (Receive). Their permissions are asked
  when money first arrives.
- Permissions go through JAW's own screens; the spender is `GooseExecutor`. Each limit is one typed amount.
- Until Chainlink approves the automation (`NEXT_PUBLIC_AGENTS_LIVE=1`), "Coming soon" stands where the switches and
  Save are; the figures are real. The invisible grants wait too: Start earning is its batch alone (no Save grant), and
  "Do this automatically next time?" (the Receive grant) isn't asked.
- The Agents feed shows the agents' moves only. "Turn off all agents" shows only while one is on.
- Rebalance only moves stocks that don't back credit, and never spends cash beyond the network fee. Its mix never adds
  up to more than 100%: a target stops where the other stocks' leave off.

## Words

- Never on screen: borrow, loan, lock, locked, unlock, collateral, room, protocol names in instructions. Never: cooked,
  goosed, golden.
- Use: credit, backs credit, free up, get back, in use, Cash.
- Titles and labels say **My** ("My holdings", "My credit", "My mix"); sentences say you and your.
- JAW appears only as the trust mark ("Enforced by JAW.id"), never in instructions.
- An off button says why ("Enter an amount", "Add who to send to").
- Try again is a refresh icon (its name stays "Try again" for screen readers).
- Buttons name the intent only ("Repay", "Repay & free up"). No confirm screens of ours: JAW's sheet is the
  confirmation.

## Working rules

- Claude never moves real money; Adrian signs every real step in the app.
- Keys are never printed. `.env.local` and the deployer key stay private.
- Push to `origin` (hannibaluslab/greedygoose) only, never to the `leo` remote.
- An approved screen never changes as a side effect. Big product calls are asked first.
