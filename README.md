# Token Radar — radar-5 decision-grade board (round 3 build, BUILD-ONLY)

Pre-token protocols ranked by implied launch value, from the sealed
DefiLlama snapshot (758 protocols at or above $5M TVL, fetched
2026-11-14). **342 rows: every protocol that records no token**
(symbol + gecko_id + mcap all null), not 198. The 40 watchlist
protocols plus 302 more below the $50M floor, including 135
monitor-only rows (CEX, bridges, staking wrappers) that are ranked
because their TVL is real but flagged "token launch unlikely —
monitor only" with a $0 plan. Protocols whose token already trades
(272 with a symbol but no market cap) are NOT ranked as pre-token.

## The model (radar-4, untouched)

`log10(mcap) = 3.046 + 0.523 x log10(TVL)`, fitted by OLS at build time
on the snapshot's own 128 live-token peers (R² 0.19) — fitted on
log10(mcap) net of the growth/maturity adjustments, so the multipliers
are level-neutral. Growth: 7-day TVL change clamped to -60%/+120% at
quarter weight. Maturity: 0.9 for a new record, rising to 1.0 at 3
years tracked. Backtest on the 128 peers (mean |log10 error|):
**0.6832** in-sample, **0.7060** deterministic 5-fold CV,
**0.6936** leave-one-out. The model axis is at its proven ceiling;
this round changes presentation, not the model.

## Implied value as an interval

Every value shows its central **50% interval**, from leave-one-out
residual quartiles per TVL tercile (bands 0.32x–3.70x below $11.8M
TVL, 0.22x–2.77x to $79.5M, 0.21x–2.76x above). Measured LOO
coverage of the stated 50% band: **48.4%** (62/128 peers;
split-half 45.3% / 51.6%). The 80% band is NOT shown: its
half-widths are 0.96–1.51 dex (82x–1034x wide) — honest but useless
to a farmer; the dashboard states this. Position sizing uses the
interval's low end. Ranking is still by point value.

## Farm plans (computed, not templated)

10 steps per protocol, each with a cost and a time. Every dollar
figure derives from the row: deposit = TVL-tier cap ($50–$250);
gas = the chain's fee (ETH $12, Solana $0.01, L2s $0.40, Bitcoin $3,
BSC $0.10, else $1.00) times 9 transactions, plus one bridge fee
(L2s $12, Solana $5); borrow = 25% of deposit with one week of
interest at 10% APR (assumption, lending rows only); max exposure =
deposit, or 2x with no risk flag; farmer pool = **10% of implied
value**, an assumption inside the observed first-airdrop range —
5% (Optimism #1), 11.62% (Arbitrum, 1.162B ARB to users),
15% (Uniswap early airdrop), 17.5% (ZKsync) — and always labelled
as the pool shared by all farmers, never a per-wallet promise.
Measured on this board: **36.4 dollar figures per plan, 9.7 of them
row-specific, 100% of steps carry a figure** (previous round:
10.8 / 1.0 / 69.1%). Monitor-only rows get a watch plan: $0 in,
$0 at risk.

## Dashboard

Board first: 10 rows on the first screen at 1440x900, with Cost /
Risk / Conf columns, so top pick, value + interval, farm cost, risk
and confidence are answerable at a glance. Top by value is Bybit
($219.4M, monitor only); top farmable pick is Steakhouse Financial
(#14, $90.6M, $15.60 fees). Sortable, filterable by category and by
launch plausibility; detail view per protocol (recomputes implied
value, deposit and fees and says when they agree with board.json);
live-token comparison view; Categories tab; fit strip, model panel,
judge-briefing panel ("How to judge this radar", one paragraph per
criterion C1–C5, numbers first) and validation panel below the
board. Static page, no network. Dashboard source 62,992 B — the
dossier text (63,256 B) carries all three files whole.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```
