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
- The menu: Activity, Guide (/guide) and Settings.
- **The Guide** is task first: each row is something a person wants to do ("Buy a stock"), then where it is in the
  app's own labels (Invest › Market), at most three steps, one line to know and a link that opens that screen. It
  starts with the app in three lines and where things are, and ends with the words the app uses. Agents and the
  Leaderboard carry "Coming soon" / "Opens soon" from the same flags the app reads. Readable signed out.
- Activity also lists money and stocks someone else sent ("Received …"), from Alchemy's Transfers API (USDC's and the
  stocks' transfers to the account), a week at a time with Show earlier, back to the app's first block (2026-09-18).
  Received money is money put in, not profit; under a cent in all is dust and isn't shown. Base's public RPC refuses
  getLogs, so it stays off until NEXT_PUBLIC_ALCHEMY_KEY is set. The Cash sheet's "Received" rows (the last 7 days, USDC
  only) wait for the same: until then it lists the user's own moves alone, with no "couldn’t load" notice.
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

| Band  | Health factor | What happens                                                                    |
| ----- | ------------- | ------------------------------------------------------------------------------- |
| Safe  | 1.5 and above | Nothing                                                                         |
| Watch | 1.1 to 1.5    | Allowed. Ending in Watch asks for one tick                                      |
| Act   | under 1.1     | A warning. Nothing the user does may end here. Protect steps in only under 1.03 |

- **1.12 is the line.** Taking credit and freeing stock never end below 1.12 (Act line + 0.02). There is no other cap
  on leverage.
- **Aave's own check runs before JAW's sheet.** Every batch that takes credit or frees stock is simulated on Base with
  the health read after it; a result under 1.10 stops it.
- **Protect** acts only under 1.03, Protect's line (Adrian, 2026-10-19). Act is a warning only: a card on the Agents
  tab from a plain health check (Top up, Repay), Protect on or off, and a push the runner sends. Under 1.03 Protect
  repays from cash first and, if cash runs short, sells backing stock at once (no heads-up, no wait), both back to
  1.12. Once it acts, the rescue goes on, above 1.03 too, until the credit is back at 1.12. It never sells while
  prices are held (weekends and holidays), and never for less than 3% under Aave's price. It has no amount limit.
- **The weekend card** warns against Aave's line: before prices pause, if stocks reopening 15% lower would take the
  credit under 1.0, it says so and what repaying now keeps it over the line. Nothing moves.
- On Home, Credit's ⓘ opens "My credit status", on Aave's rules: the health and how far the stocks can fall, all
  together, before Aave's line (1.0) and before Act (1 − line ÷ health); how it's worked out (each stock that backs
  credit counts its value × the share Aave counts, together ÷ what's owed); and the scale: Safe, Watch, Act (a
  warning), under 1.03 (Protect repays from cash, then sells if needed) and Aave's line, each with where it starts and
  what happens there. The owed amount opens the Credit sheet.

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
- **Turn into cash** (the user's own conversion) takes USDT, USDe, USDS, DAI and EURC; USDbC is dropped (Adrian,
  2026-10-19). Each coin is approved and swapped only at its own venue and pool, into USDC for the user. A dollar coin's
  floor is 99.5% of face value; EURC's is 99.5% of its value at Chainlink's EUR / USD rate, read again at signing (a
  rate that rose raises the floor, one that fell never lowers it), and refused when the rate is over two hours old or
  reads 0 or less. The Entry agent keeps its own list until the executor's pre-launch redeploy.
- **One stock order** in every list: Home's (Apple, Amazon, Alphabet, Meta, Microsoft, NVIDIA, Tesla). Lists keep
  their groups (what can go before what can't); a default still opens on the cash or the biggest free stock.

## Earn with stocks (Cash sheet)

- The earn step lists the free stocks under "Back it with", all ticked to start; a tap leaves one out or takes it
  back, and the most it can add follows what's ticked (offerFor). What already backs credit always counts
  (Adrian, 2026-10-19: one, several or all, not always all).
- Once some of the cash came from credit, the card says how much ("$1.95 from credit is earning"), always with the live
  rates (what the cash earns, what the credit costs, what's left: "Live, a year. Both are variable.") and **Used for
  this**: each stock that backs credit, its shares and their value at Aave's price, scaled to the earning part of what's
  owed ("Apple 0.0012 ($0.41)"), since every backing stock backs all of the credit as one pool (Adrian, 2026-10-19). It
  keeps "Add more" while more is possible, and offers **Stop earning with stocks**: the Cash
  sheet slides out and Repay opens with that cash to repay and the stocks that back credit ticked to free up, in one
  signature. "Your stocks can't back more credit right now" no longer shows while it earns.

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
  it; repaying first frees more. "Clear" takes every tick off. Under each stock, one format on every row: what comes
  out with its value beside it, of what backs credit ("0.0047 ($1.63) of 0.0147"; "0 of 0.0147" when nothing can). The button reads Repay, Free up, or Repay & free up.
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
  Coming soon, with nothing to open yet. DCA and Top-ups go into my mix are either/or. DCA isn't built.
- Invisible: earning on idle cash (Save) and turning other dollars into cash (Receive). Their permissions are asked
  when money first arrives.
- Each change is one batch, one Face ID (D14 dropped, Adrian 2026-10-20): its permissions approved in JAW's manager and
  registered with the executor, the ones they replace (or a turn-off's) revoked, with the settings and any cash move,
  then recorded in JAW's list. The card says what its Face ID allows before the tap. The spender is `GooseExecutor`.
  An account JAW hasn't deployed yet starts earning in one too.
  Protect and Rebalance have no amount limit:
  their grants (Protect's repay from cash and sell, Rebalance's trades) are at the executor's CAP_MAX, with no field to
  type. Each is limited by its rules. A Rebalance grant capped below CAP_MAX, from before, is granted again at the
  next Save.
- The Rebalancer waits while the credit is in Act (under 1.1), not down to Protect's line.
- Until the agents go live (`NEXT_PUBLIC_AGENTS_LIVE=1`), "Coming soon" stands where the switches and
  Save are; the figures are real. The invisible grants wait too: Start earning is its batch alone (no Save grant), and
  Turn into cash is the conversion alone (no Receive grant). Once live, Turn into cash's one Face ID also has the next
  ones convert on their own, and the card says so before the tap.
- The Agents feed shows the agents' moves only. Each agent turns off from its own sheet.
- Rebalance only moves stocks that don't back credit, and never spends cash beyond the network fee. Its mix never adds
  up to more than 100%: a target stops where the other stocks' leave off.
- **Top-ups go into my mix**, a Rebalance setting, off by default, with **Keep $X as cash** ($500 by default,
  whole dollars, $0 allowed). A top-up is money that comes in from outside: USDC sent to the account, and other dollar
  coins turned into cash. A sale's proceeds and credit taken as cash are never top-ups (they go into savings inside the
  user's own batch), nor is the change the agents' sales leave; the change from the user's own sales (about 1%) counts
  as one. A top-up fills cash up to Keep $X first, and only the part above goes into the mix (Keep $0: all of it). It
  goes in at the next market morning's check, never the day it arrived, and earns until then. Rebalance takes it from
  savings and buys the stocks furthest below their target first, then pro rata to the mix. It never sells for this, has
  no amount cap, and waits while the credit is in Act. If the cash falls after a top-up is counted, the fall comes out
  of the waiting top-up first. With the setting off, Rebalance spends no cash.
- **How top-ups run.** Only Save counts top-ups, so turning the setting on also turns on earning, in the same
  signature. Save counts what it puts in savings; Rebalance, at its daily check, invests the smaller of that count and
  the cash above Keep $X. The Rebalance grant carries Aave V3's savings withdraw (to the account only) only while the
  setting is on, so switching it on or off is a new grant; changing Keep alone is the setting only. Turning Rebalance
  off switches top-ups off in the same signature; once Rebalance has stopped, switching them off is the setting alone.
  Save has no amount limit either, its grant at the executor's CAP_MAX: Rebalance's Save grants it so, and Start
  earning's grant and words follow **(to build)**. The sheet shows what's waiting and when it goes in, and warns when
  Keep is $0, something is owed and Protect can't sell; the card and the sheet's line show a top-up going in at the
  next check and the stocks it buys. A Save that drops a waiting top-up (a new grant, or the switch flipped) says so
  first. Until the executor that counts top-ups is live, the setting says "Not available yet."

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
- No em dashes, and no colon joining two sentences. Top up is the only name for adding money. Copy edits never make a
  string longer (Adrian, 2026-10-19).

## Working rules

- Claude never moves real money; Adrian signs every real step in the app.
- Keys are never printed. `.env.local` and the deployer key stay private.
- Push to `origin` (hannibaluslab/greedygoose) only, never to the `leo` remote.
- An approved screen never changes as a side effect. Big product calls are asked first.
