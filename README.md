# Quartet: a paper-trading desk for four tested strategies

Four strategies that survived our own re-test of two research reports, running as an automatic paper-money experiment.
A scanner runs on GitHub every 30 minutes, simulates the four strategies on fresh market data, and updates a dashboard on GitHub Pages. Nothing here places real orders.

| Strategy | Market | What it does |
|---|---|---|
| RSI(2) dip buy | SPY + QQQ | Buys sharp dips in an uptrend, sells the bounce |
| IBS dip buy | SPY + QQQ | Buys days that close at the bottom of their range |
| Funding carry | BTC + ETH | Holds the coin, shorts the future, collects funding |
| Supertrend | 13 altcoins | Follows new trends in the direction BTC allows |

Each strategy has its own paper account (10,000 paper dollars by default), so you can see which one is helping and which one is not.

## Set it up (about 5 minutes)

1. Create a new GitHub repository and upload the contents of this zip (the `.github`, `docs` and `scanner` folders, `config.json` and this file).
2. **Settings > Pages**: Source = *Deploy from a branch*, Branch = `main`, Folder = `/docs`. Save.
3. **Settings > Actions > General > Workflow permissions**: choose *Read and write permissions*. Save.
4. **Actions** tab > *Quartet scan* > *Run workflow*. After about a minute the first results are committed.
5. Open your Pages address (shown in Settings > Pages). Add `?demo` to the address to preview the page with sample data.

The paper run starts at the moment of the first scan. That moment is saved as `startMs` in `config.json`. Delete that line to restart the experiment.

## Settings (`config.json`)

| Key | Meaning |
|---|---|
| `startEquity` | Paper dollars for each strategy |
| `risk` | Fraction of a strategy's equity risked per trade (RSI(2), IBS, Supertrend). 0.01 is 1% |
| `carryNotional` | Fraction of the carry strategy's equity held as spot in each coin (the same amount is shorted) |
| `enabled` | Turn any strategy off with `false` |

## The exact rules (frozen before the run, from the Colab tests)

- **RSI(2):** the 2-day RSI closes below 5 while the ETF is above its 200-day average. Buy at the close. Stop at 2 ATR below. Exit at the first close with RSI(2) above 65, or after 5 trading days.
- **IBS:** (close - low) / (high - low) below 0.05. Buy at the close. Stop at 2 ATR below. Exit at the first close with IBS above 0.75, or after 7 trading days.
- **Carry:** the 21-day average of daily funding, annualised, above 5% opens the hedge; below 0% closes it. Costs 0.2% per side.
- **Supertrend:** Supertrend(14, 3) flips on the daily close; BTC above its 200-day average allows longs only, below allows shorts only. Enter at the next open. Stop 3 ATR, target 3 times the risk, time exit after 30 days.

Costs: 0.1% round trip on ETFs, 0.3% on altcoins, 0.4% on the carry. Stops that gap through fill at the open, which is worse than the stop price.

## How to read the dashboard

* **Evidence bands** compare each paper result with its backtest. The shaded range is where luck alone should put the result, and it narrows as trades accumulate. While the range is hatched, there is too little data to conclude anything.
* **Experiment clock:** week 8 checks the machinery (do signals fire, are the fills sane, are the feeds reliable). Month 6 is a first look. Month 12 is the first verdict that means something, because these strategies trade rarely: at the backtested pace RSI(2) closes about one trade a month.

## Data sources and what can go wrong

* ETFs: Yahoo Finance, with Stooq as a fallback.
* Crypto candles: `data-api.binance.vision` (works from GitHub's US servers).
* Funding: Binance's monthly archive for past months. For the recent days, the scanner tries the Binance API (often blocked from US servers), then rebuilds the funding from Binance's public premium-index files and checks that rebuild against known history, then uses OKX as a last-resort proxy. The dashboard names the source in use. If every source fails, the carry panel says the data is old and its signals pause.
* If a feed fails, that strategy shows the last good results with a "Data issue" label. The other strategies keep running.

## Honest limits

* Paper trading checks that the machinery works and that results do not drift far from the backtest. It cannot prove an edge in a few weeks.
* The Supertrend universe is today's 13 coins (survivorship bias is possible) and shorts assume a perpetual future is available. Funding paid on those positions is not included.
* The carry is shown on the notional it hedges. Real money also needs margin for the short leg, and a sharp spike can liquidate it.
* GitHub pauses scheduled workflows after 60 days without repository activity. The scan commits its own results, which normally counts as activity. If the page goes stale, run the workflow once by hand.

## Optional: Telegram alerts

Add two repository secrets (Settings > Secrets and variables > Actions): `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. You will get a message for each new paper entry or exit.

## Files

* `scanner/core.js`: the strategy rules and the paper-trading replay (no network).
* `scanner/run.js`: data fetching, the scan, and writing `docs/data/state.json`.
* `scanner/meta.js`: descriptions and the backtest numbers the paper account is compared with.
* `docs/index.html`: the dashboard. `docs/data/demo.json`: sample data for `?demo`.
* `.github/workflows/scan.yml`: the schedule.

Paper money only. Not financial advice.
