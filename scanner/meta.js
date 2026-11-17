'use strict';
/* Static descriptions + the numbers the paper account is compared against (from the Colab replication runs of Nov 2026). */
const SLEEVES = {
  rsi2: {
    id: 'rsi2', name: 'RSI(2) dip buy', short: 'RSI(2)', market: 'SPY + QQQ', cadence: 'Checked once a day, after the US close', direction: 'Long only',
    idea: 'Buys a sharp, short-lived drop in an index that is in a long-term uptrend, then sells the bounce.',
    rules: ['Signal: the 2-day RSI closes below 5 while the ETF closes above its 200-day average.', 'Entry: buy at that day\u2019s close.', 'Stop: 2 \u00d7 ATR(14) below the entry.', 'Exit: the first close with RSI(2) above 65, or after 5 trading days.', 'Size: risk 1% of this strategy\u2019s paper equity per trade.'],
    backtest: { win: 0.70, avgR: 0.156, pf: 1.71, maxDD: -0.083, perMonth: 1.25, rStd: 0.58, exposure: 0.127, cagr: 0.023, buyHold: 0.131, span: '2005\u20132026, 323 trades', metric: 'R' },
    evidence: { numbers: 'Core figures reproduced (win rate, profit factor, drawdown)', checks: '8 of 8', beatsRandom: 'p < 0.001' }
  },
  ibs: {
    id: 'ibs', name: 'IBS dip buy', short: 'IBS', market: 'SPY + QQQ', cadence: 'Checked once a day, after the US close', direction: 'Long only',
    idea: 'Buys when a day closes at the very bottom of its own range, then sells once it recovers.',
    rules: ['Signal: Internal Bar Strength (close \u2212 low) \u00f7 (high \u2212 low) below 0.05.', 'Entry: buy at that day\u2019s close.', 'Stop: 2 \u00d7 ATR(14) below the entry.', 'Exit: the first close with IBS above 0.75, or after 7 trading days.', 'Size: risk 1% of this strategy\u2019s paper equity per trade.'],
    backtest: { win: 0.719, avgR: 0.108, pf: 1.56, maxDD: -0.061, perMonth: 1.95, rStd: 0.55, exposure: 0.20, cagr: 0.025, buyHold: 0.131, span: '2005\u20132026, 501 trades', metric: 'R' },
    evidence: { numbers: 'Reproduced, including the report\u2019s tight variant exactly', checks: '8 of 8', beatsRandom: 'p = 0.001' }
  },
  carry: {
    id: 'carry', name: 'Funding carry', short: 'Carry', market: 'BTC + ETH', cadence: 'Funding is paid every 8 hours; checked daily', direction: 'Market neutral',
    idea: 'Holds the coin and shorts the same amount on the perpetual future, so price moves cancel and the funding payments are the profit.',
    rules: ['Signal: the 21-day average of daily funding, annualised, is above 5%.', 'Entry: open the hedged pair (long spot, short perpetual) at the next day\u2019s start.', 'Exit: when that annualised average drops below 0%.', 'Size: 40% of this strategy\u2019s paper equity per coin as spot, with the same amount short.', 'Costs: 0.2% per side (fees and slippage on both legs).'],
    backtest: { win: 0.54, perMonthRet: 0.0045, pf: null, maxDD: -0.014, perMonth: 0.21, inPosition: 0.74, cagr: 0.054, span: '2021\u20132026, 13 trades per coin', metric: 'pct' },
    evidence: { numbers: 'Economics match (funding collected, drawdown); trade count differs', checks: '8 of 8', beatsRandom: 'not applicable' }
  },
  st: {
    id: 'st', name: 'Supertrend trend follower', short: 'Supertrend', market: '13 altcoins', cadence: 'Checked daily, after the 00:00 UTC candle closes', direction: 'Long and short',
    idea: 'Follows a new trend on each altcoin, but only in the direction BTC\u2019s long-term trend allows.',
    rules: ['Signal: the Supertrend (14, 3) indicator flips direction on the daily close.', 'Filter: longs only when BTC closes above its 200-day average, shorts only when it is below.', 'Entry: the next day\u2019s open.', 'Stop: 3 \u00d7 ATR(14). Target: 3 \u00d7 the risk. Time exit: 30 days.', 'Size: risk 1% of this strategy\u2019s paper equity per trade.'],
    backtest: { win: 0.496, avgR: 0.219, pf: 1.59, maxDD: -0.227, perMonth: 3.7, rStd: 1.4, cagr: null, span: '2021\u20132026, 232 trades', metric: 'R' },
    evidence: { numbers: '6 of 8 report figures reproduced; return and drawdown were worse', checks: '7 of 8', beatsRandom: 'p = 0.003' }
  }
};

const RESEARCH = {
  headline: 'The target was an 85% win rate. None of the strategies reached it. The four marked as running are the ones whose edge survived our own re-test.',
  tested: [
    { name: 'RSI(2) dip buy', market: 'SPY + QQQ', verdict: 'live', numbers: 'Core figures reproduced', checks: '8/8', note: 'Beats random entries; 12 of 12 parameter sets profitable.' },
    { name: 'IBS dip buy', market: 'SPY + QQQ', verdict: 'live', numbers: '5 of 6 figures', checks: '8/8', note: 'The report\u2019s tight variant came out identical.' },
    { name: 'Funding carry', market: 'BTC + ETH', verdict: 'live', numbers: 'Economics match', checks: '8/8', note: 'Real but small, and fading: about +4% in 2025, about +1% in 2026 so far.' },
    { name: 'Supertrend + BTC filter', market: '13 altcoins', verdict: 'live', numbers: '6 of 8 figures', checks: '7/8', note: 'Modest edge; the bootstrap interval still includes zero. Today\u2019s coins only, so survivorship bias is possible.' },
    { name: 'Donchian breakout', market: 'BTC, ETH', verdict: 'rejected', numbers: 'BTC yes, ETH no', checks: '3/8 and 2/8', note: 'Not better than random entries; drawdowns of 39% and 81%.' },
    { name: 'Z-score reversion', market: 'GBP/USD', verdict: 'rejected', numbers: '4 of 8 figures', checks: '1/8', note: 'Only 30 trades; loses money when costs double.' }
  ],
  cannot: [
    'These strategies trade rarely. At the backtested pace the RSI(2) strategy needs about two years to close 30 trades. A few weeks of paper results cannot confirm a win rate.',
    'What the paper account does check: signals fire when they should, fills are realistic, the data feeds hold up, and nothing drifts far from the backtest.',
    'Shorts on altcoins assume a perpetual future is available, and their funding costs are not included.',
    'Carry is shown on the notional it hedges. Real capital also needs margin for the short leg, and a spike can liquidate the short.'
  ]
};
module.exports = { SLEEVES, RESEARCH };
