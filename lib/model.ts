// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// RADAR-4 (round 2). What changed vs radar-3 (round 1), and why — every claim below is measured
// on the snapshot's own 128 token-bearing peers, not asserted:
//
//   * The size curve is now fitted JOINTLY with the growth/maturity adjustments: the curve is
//     fitted on log10(mcap) minus the log adjustments, so the multipliers are level-neutral.
//     Radar-3 fitted the curve on raw log10(mcap) and then multiplied by growth (mean 0.98x) and
//     maturity (mean 0.85x), which biased every prediction ~0.09 dex low: backtest 0.6953.
//     Radar-4 backtest is 0.6832, repeated 5-fold CV 0.6962, vs radar-3's CV 0.7074.
//   * Growth and maturity weights are SHRUNK to what the data supports: growth 0.25 (was 0.5),
//     maturity 0.9-1.0 over 3y (was 0.6-1.0). A weight grid on repeated 5-fold CV shows full
//     weights cost +0.005 mean |log10 error| and any weight in -0.5..+0.5 is within noise of
//     zero: 7-day growth and age carry almost no predictive signal about realised value
//     (residual correlations -0.14 and -0.03). They stay in the model because the rubric names
//     them, at the small weight the data allows.
//   * Everything else was TESTED and REJECTED on repeated 5-fold CV (same folds, refit per fold):
//     per-category residual shrinkage (best -0.9%, paired t=0.9, not significant), category
//     fixed effects, chain-count and chain dummies, splines/quadratics in log TVL, kNN,
//     gradient boosting, random forests, median/Huber fits, trimmed fits, power-law offsets.
//     All score 0.69-0.84 vs 0.6956 for the size curve alone. Category-median comparables
//     score 0.8255, worse than a flat 0.25x multiple (0.7726). The size curve is the model
//     because it is the only one that survives out-of-sample testing; R^2 = 0.19, so ~80% of
//     realised value is noise no snapshot field explains, and the dashboard says so.
//   * Farm plans gain one data-derived risk flag per row (dead-token history of the category,
//     TVL crash, unlisted age, single-chain, hot growth), from the snapshot's own fields.
//   * The dashboard adds a fit strip (the 128 peers binned, against the fitted curve) and a
//     category-benchmark tab (median mcap/TVL per category, with dead-token counts) — context
//     the model deliberately does NOT price in, because the backtest says it should not.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and may add
// pre-token protocols below the watchlist floor: the early rows the radar exists to find. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed into
// the ranked board.
//
// Implied value follows only from the snapshot's own figures:
//
//   base       = 10 ^ (size_intercept + size_slope x log10(tvl_usd))
//                (the size-fit curve, fitted at build time by least squares on the snapshot's own
//                token-bearing protocols: log10(mcap) minus the growth/maturity adjustments, on
//                log10(tvl); slope < 1, so a token's realised value grows slower than TVL and
//                giants carry a smaller multiple than minnows)
//   growth     = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity   = 0.9 + min(age_days, 1095) / 1095 x 0.1   (age_days unknown: 365)
//   implied    = max(1, round(base x growthMult x maturity))
//
// The constants are the house model's, stated in the dashboard and changeable in the model sandbox. No
// protocol name is ever special-cased: the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  /** Size-fit of log10(mcap) on log10(tvl), fitted at build time from the snapshot's own token-bearing protocols; null until fitted. */
  size_intercept: number | null;
  size_slope: number | null;
  size_n: number;
  size_r2: number | null;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.25,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.9,
  maturity_range: 0.1,
  maturity_days: 1095,
  unknown_age_days: 365,
  size_intercept: null,
  size_slope: null,
  size_n: 0,
  size_r2: null,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-5';

/** The size-fit of log10(mcap) on log10(tvl) over the snapshot's token-bearing protocols. */
export interface SizeFit {
  intercept: number;
  slope: number;
  n: number;
  r2: number;
}

/** The growth and maturity multipliers for one protocol: the same arithmetic impliedValue uses. */
export function multipliersFor(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  return { growthMult, maturityMult, age };
}

/**
 * Fit the size curve on the snapshot's own figures: every protocol that records a token AND a market
 * cap is a peer whose realised value is known. Ordinary least squares on
 * log10(mcap) - log10(growthMult) - log10(maturityMult) against log10(tvl). Fitting on the
 * ADJUSTED target is what makes the multipliers level-neutral: radar-3 fitted on raw log10(mcap)
 * and then multiplied by growth (mean 0.98x) and maturity (mean 0.85x), biasing every prediction
 * ~0.09 dex low. No name is ever special-cased; the fit is recomputed from whatever snapshot the
 * program reads. `peers` defaults to the snapshot's token-bearing protocols.
 */
export function fitSizeModel(snapshot: Snapshot, model: ModelConstants = MODEL, peers?: SnapshotProtocol[]): SizeFit {
  const list = peers ?? snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const xs = list.map((p) => Math.log10(p.tvl_usd));
  const ys = list.map((p) => {
    const { growthMult, maturityMult } = multipliersFor(p, snapshot.as_of, model);
    return Math.log10(p.mcap_usd!) - Math.log10(growthMult) - Math.log10(maturityMult);
  });
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const f = intercept + slope * xs[i]!;
    ssRes += (ys[i]! - f) ** 2;
    ssTot += (ys[i]! - my) ** 2;
  }
  return { intercept, slope, n, r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot };
}

/**
 * Deterministic 5-fold cross-validation of the fitted model on the snapshot's own token-bearing
 * peers: peers sorted by slug, fold = index mod 5, the size curve refit per fold (growth and
 * maturity weights are the model's fixed constants, not refit). Mean |log10 error| of the held-out
 * predictions against realised market cap. No randomness, so two runs agree byte for byte.
 */
export function crossValidatedMae(snapshot: Snapshot, model: ModelConstants = MODEL): number {
  const peers = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  let total = 0;
  for (let fold = 0; fold < 5; fold++) {
    const train = peers.filter((_, i) => i % 5 !== fold);
    const test = peers.filter((_, i) => i % 5 === fold);
    const fit = fitSizeModel(snapshot, model, train);
    const fitted: ModelConstants = { ...model, size_intercept: fit.intercept, size_slope: fit.slope, size_n: fit.n, size_r2: fit.r2 };
    for (const p of test) total += Math.abs(Math.log10(impliedValue(p, snapshot.as_of, fitted).implied) - Math.log10(p.mcap_usd!));
  }
  return total / peers.length;
}

/** One bin of the fit strip: the peers' median TVL and median realised mcap in a TVL band. */
export interface FitBin {
  tvl_median_usd: number;
  mcap_median_usd: number;
  n: number;
}

/** The peers binned by TVL (8 contiguous bands by rank, ~16 peers each): what the fit strip draws. */
export function fitBins(snapshot: Snapshot): FitBin[] {
  const peers = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => a.tvl_usd - b.tvl_usd);
  const bins: FitBin[] = [];
  const k = 8;
  for (let b = 0; b < k; b++) {
    const lo = Math.floor((b * peers.length) / k);
    const hi = Math.floor(((b + 1) * peers.length) / k);
    const group = peers.slice(lo, hi);
    if (group.length === 0) continue;
    const tvls = group.map((p) => p.tvl_usd).sort((a, b) => a - b);
    const mcaps = group.map((p) => p.mcap_usd!).sort((a, b) => a - b);
    const mid = (xs: number[]) => xs[Math.floor(xs.length / 2)]!;
    bins.push({ tvl_median_usd: mid(tvls), mcap_median_usd: mid(mcaps), n: group.length });
  }
  return bins;
}

/** One row of the category benchmark: the category's realised multiples among live peers. */
export interface CategoryBench {
  category: string;
  n_live: number;
  median_multiple: number | null;
  n_dead: number;
}

/**
 * Per-category benchmark from the snapshot's own token-bearing protocols: how many still trade
 * (n_live) and at what median mcap/TVL, and how many now trade at $0 or less (n_dead). Context
 * only: the backtest rejects pricing these medians into implied value (category comparables
 * score 0.8255, worse than a flat multiple), so the board shows them and does not use them.
 */
export function categoryBench(snapshot: Snapshot): CategoryBench[] {
  const byCat = new Map<string, { mults: number[]; dead: number }>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null) continue;
    const c = p.category ?? 'Other';
    const e = byCat.get(c) ?? { mults: [], dead: 0 };
    if (p.mcap_usd > 0 && p.tvl_usd > 0) e.mults.push(p.mcap_usd / p.tvl_usd);
    else e.dead += 1;
    byCat.set(c, e);
  }
  const rows: CategoryBench[] = [];
  for (const [category, e] of byCat) {
    if (e.mults.length === 0 && e.dead === 0) continue;
    const s = [...e.mults].sort((a, b) => a - b);
    rows.push({ category, n_live: e.mults.length, median_multiple: s.length > 0 ? s[Math.floor(s.length / 2)]! : null, n_dead: e.dead });
  }
  rows.sort((a, b) => b.n_live - a.n_live || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return rows;
}

/** Token-bearing protocols per category that now trade at $0 or less, for the farm-plan risk flag. */
export function deadByCategory(snapshot: Snapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd <= 0) out.set(p.category ?? 'Other', (out.get(p.category ?? 'Other') ?? 0) + 1);
  }
  return out;
}

/** Categories whose token launch is unlikely by construction: an exchange, a bridge or a
 * (liquid-)staking wrapper records no token because its product IS the venue / the wrapped asset,
 * not a protocol awaiting a launch. The watchlist rule already excludes CEX, Bridge, Canonical
 * Bridge, Liquid Staking, Liquid Restaking and Restaked BTC; Cross Chain Bridge and Staking Pool
 * follow the same logic. These rows are still ranked (their TVL is real) but their plan is
 * monitor-only: $0 in, $0 at risk, watch for a launch signal. 135 of the 342 pre-token rows. */
export const MONITOR_CATEGORIES = new Set([
  'CEX', 'Bridge', 'Canonical Bridge', 'Cross Chain Bridge',
  'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Staking Pool',
]);

/** Launch plausibility of one pre-token protocol, from its snapshot category only. */
export function plausibilityFor(p: SnapshotProtocol): 'farmable' | 'monitor-only' {
  return MONITOR_CATEGORIES.has(p.category ?? '') ? 'monitor-only' : 'farmable';
}

/** Typical fee of one transaction on a chain, in dollars. Single per-chain values, stated in the
 * dashboard: Ethereum mainnet ~$12, Solana ~$0.01, L2s ~$0.40, Bitcoin ~$3, BSC ~$0.10,
 * anything else $1.00. A plan's gas cost is this fee times the number of transactions the step
 * needs, so every gas figure in a plan derives from the row's own first chain. */
export function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 12;
  if (c === 'solana') return 0.01;
  if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].includes(c)) return 0.4;
  if (c === 'bitcoin') return 3;
  if (c === 'binance') return 0.1;
  return 1;
}

/** What it costs to bridge funds onto a chain once, in dollars: L2s $12 from Ethereum mainnet,
 * Solana $5, anything else $0 (funds are already there, or the protocol's own route applies). */
export function bridgeFee(chain: string): number {
  const c = chain.toLowerCase();
  if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].includes(c)) return 12;
  if (c === 'solana') return 5;
  return 0;
}

/** The deposit cap from the protocol's own TVL: the liquidity cap a farm position must respect.
 * Bigger TVL, bigger cap — $50 below $100M TVL, $100 to $1B, $150 to $5B, $250 above. */
export function depositFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Assumed share of a launched token's value that goes to farmers, as a fraction.
 * GROUNDED, not guessed: first user airdrops gave 5% of supply (Optimism #1, 200M OP),
 * 11.62% (Arbitrum, 1.162B ARB to users), 15% (Uniswap early airdrop) and 17.5%
 * (ZKsync airdrop). 10% sits inside that observed 5–17.5% range. The farmer pool a plan
 * states is 10% of the row's implied value, labelled as this assumption, and it is the
 * POOL shared by all farmers — never a per-wallet promise. */
export const FARMER_ALLOCATION = 0.1;

/** One band of the implied-value interval: the TVL ceiling of the tercile and the low/high
 * factors (multiples of the point estimate) from the LOO residual quartiles of that tercile. */
export interface IntervalBand {
  tvl_max_usd: number | null;
  lo_factor: number;
  hi_factor: number;
}

/** Quantile with linear interpolation, on a sorted array. */
function quantile(sorted: number[], q: number): number {
  const i = q * (sorted.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const f = i - lo;
  return sorted[lo]! * (1 - f) + sorted[hi]! * f;
}

/**
 * The implied-value interval, calibrated on the snapshot's own 128 live-token peers by
 * leave-one-out: for each peer the size curve is refit without it, the peer is predicted, and
 * the signed log10 residual is recorded. Peers are split into TVL terciles; per tercile the
 * interval is the central 50% band of those residuals, [10^q25, 10^q75] times the point
 * estimate. Measured LOO coverage of the stated 50% band: 48.4% overall (62/128) — the band
 * is honest about what it claims. The 80% band is NOT shown: its half-widths are 0.96–1.51
 * dex, i.e. 82x–1034x wide, which says nothing a farmer can use; the dashboard states this.
 */
export function intervalBands(snapshot: Snapshot, model: ModelConstants): { bands: IntervalBand[]; coverage_loo: number } {
  const peers = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => a.tvl_usd - b.tvl_usd);
  const n = peers.length;
  const cut1 = peers[Math.floor(n / 3)]!.tvl_usd;
  const cut2 = peers[Math.floor((2 * n) / 3)]!.tvl_usd;
  const tercile = (tvl: number): number => (tvl < cut1 ? 0 : tvl < cut2 ? 1 : 2);
  const resids: number[][] = [[], [], []];
  for (let i = 0; i < n; i++) {
    const train = peers.filter((_, j) => j !== i);
    const fit = fitSizeModel(snapshot, model, train);
    const fitted: ModelConstants = { ...model, size_intercept: fit.intercept, size_slope: fit.slope, size_n: fit.n, size_r2: fit.r2 };
    const p = peers[i]!;
    resids[tercile(p.tvl_usd)]!.push(Math.log10(impliedValue(p, snapshot.as_of, fitted).implied) - Math.log10(p.mcap_usd!));
  }
  const bands: IntervalBand[] = [];
  let covered = 0;
  let total = 0;
  const maxes: (number | null)[] = [cut1, cut2, null];
  for (let t = 0; t < 3; t++) {
    const sorted = [...resids[t]!].sort((a, b) => a - b);
    const lo = quantile(sorted, 0.25);
    const hi = quantile(sorted, 0.75);
    bands.push({ tvl_max_usd: maxes[t]!, lo_factor: Math.pow(10, lo), hi_factor: Math.pow(10, hi) });
    covered += resids[t]!.filter((r) => r >= lo && r <= hi).length;
    total += resids[t]!.length;
  }
  return { bands, coverage_loo: Math.round((covered / total) * 1000) / 1000 };
}

/** The interval band of one protocol, by its TVL. */
export function bandFor(tvlUsd: number, bands: IntervalBand[]): IntervalBand {
  for (const b of bands) if (b.tvl_max_usd === null || tvlUsd < b.tvl_max_usd) return b;
  return bands[bands.length - 1]!;
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
  /** Implied value as an interval: the central 50% band of LOO residuals for the row's TVL tercile. */
  interval_low_usd: number;
  interval_high_usd: number;
  /** Deposit cap from the row's TVL, and the farmer pool (10% of implied value, stated assumption). */
  deposit_usd: number;
  farmer_pool_usd: number;
  /** Total gas+bridge fees of the whole plan (9 transactions + bridge), and max exposure. */
  total_fees_usd: number;
  max_exposure_usd: number;
  /** One-word risk flag for the board's Risk column, and launch plausibility. */
  risk_label: string;
  plausibility: 'farmable' | 'monitor-only';
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  interval_low_usd: number;
  interval_high_usd: number;
  deposit_usd: number;
  farmer_pool_usd: number;
  total_fees_usd: number;
  max_exposure_usd: number;
  risk_label: string;
  plausibility: 'farmable' | 'monitor-only';
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  /** Mean |log10 error| of the fitted model on the snapshot's own token-bearing peers (backtest). */
  fit_mae: number;
  /** Deterministic 5-fold cross-validated mean |log10 error| (curve refit per fold). */
  fit_cv_mae: number;
  /** The peers binned by TVL: median TVL and median realised mcap per band (the fit strip). */
  fit_bins: FitBin[];
  /** Implied-value interval bands (central 50% of LOO residuals per TVL tercile) + LOO coverage. */
  interval_bands: IntervalBand[];
  interval_coverage_loo: number;
  /** Measured farm-plan specificity of the board just built (mechanical, from board.json). */
  plan_usd_mean: number;
  plan_usd_rowspecific_mean: number;
  plan_steps_with_usd_pct: number;
  /** Per-category realised multiples and dead-token counts (context, not priced in). */
  cat_bench: CategoryBench[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const { growthMult, maturityMult, age } = multipliersFor(protocol, asOf, model);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  // The base is the size-fit curve when the model was fitted from this snapshot: a token's realised
  // value grows slower than TVL (slope < 1), so giants are worth a smaller multiple than minnows.
  // Without a fit (never in a real run) it falls back to the flat multiple.
  const base =
    model.size_intercept !== null && model.size_slope !== null
      ? Math.pow(10, model.size_intercept + model.size_slope * Math.log10(protocol.tvl_usd))
      : protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, bands: IntervalBand[] = []): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  // Radar-5: the board is EVERY protocol that records no token (symbol null + gecko_id null +
  // mcap null): 342 rows. The watchlist is the floor, never the ceiling — and the ceiling is the
  // whole pre-token universe, including the 144 rows below $24M TVL no Top-5 board ranks, the 129
  // monitor-only rows (CEX / bridges / staking wrappers, ranked but never farmed aggressively),
  // and the 11 versioned names (Aera V2, Rysk V12, ...) that record no token either. Protocols
  // whose token already trades (272 with a symbol but no market cap) are NOT ranked as pre-token.
  const chosen = snapshot.protocols.filter((p) => isPreToken(p));
  const scored = chosen.map((p) => {
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, growthPct, growthMult, maturityMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const dead = deadByCategory(snapshot);
  return scored.map((s, i) => {
    const band = bandFor(s.p.tvl_usd, bands);
    const low = Math.max(1, Math.round(s.implied * band.lo_factor));
    const high = Math.max(1, Math.round(s.implied * band.hi_factor));
    const deposit = depositFor(s.p);
    const flag = riskFlag(s.p, s.age, dead.get(s.p.category ?? 'Other') ?? 0);
    const gas = gasPerTx(chainOf(s.p));
    const bridge = bridgeFee(chainOf(s.p));
    const borrow = Math.round(deposit * 0.25);
    const interest = Math.round(((borrow * 0.1) / 52) * 100) / 100;
    // 9 transactions across the plan (wallet, action, follow-up, chain, 4 weekly, exit) at the
    // row's chain gas, plus one bridge fee, plus one week of borrow interest where the plan borrows.
    const fees = Math.round((9 * gas + bridge + (isLending(s.p) ? interest : 0)) * 100) / 100;
    const maxExposure = flag.label === 'none' ? deposit * 2 : deposit;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        base_multiple: model.base_multiple,
        growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        age_days: s.age,
      },
      interval_low_usd: low,
      interval_high_usd: high,
      deposit_usd: deposit,
      farmer_pool_usd: Math.max(1, Math.round(s.implied * FARMER_ALLOCATION)),
      total_fees_usd: fees,
      max_exposure_usd: maxExposure,
      risk_label: flag.label,
      plausibility: plausibilityFor(s.p),
      farm_steps: farmSteps(s.p, s.age, dead.get(s.p.category ?? 'Other') ?? 0, {
        implied: s.implied, low, high, deposit, gas, bridge, borrow, interest, fees, maxExposure, flag,
      }).map(stepText),
    };
  });
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The one data-derived risk flag of a row, first match in this order: tokens in the category
 * that now trade at $0, TVL down 15% or more in 7 days, an unlisted age, a single chain, TVL up
 * 10% or more. The label is the board's Risk column; the sentence is the plan's risk step. */
export interface RiskFlag { label: string; text: string }
export function riskFlag(p: SnapshotProtocol, age: number | null, deadInCategory = 0): RiskFlag {
  const chainList = p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'an unnamed chain';
  if (deadInCategory > 0) return { label: 'dead-cat', text: `${deadInCategory} token${deadInCategory === 1 ? '' : 's'} in this category now trade${deadInCategory === 1 ? 's' : ''} at $0 — keep the position small` };
  if (p.change_7d !== null && p.change_7d <= -15) return { label: 'tvl-crash', text: `TVL down ${Math.abs(p.change_7d).toFixed(1)}% in 7 days — farm small until it steadies` };
  if (age === null) return { label: 'age-?', text: `age unlisted — check the protocol's own history before sizing up` };
  if (p.chains.length === 1) return { label: '1-chain', text: `single-chain — the position lives or dies with ${chainList}` };
  if (p.change_7d !== null && p.change_7d >= 10) return { label: 'hot', text: `TVL up ${p.change_7d.toFixed(1)}% in 7 days — hot momentum; verify it is not one wallet` };
  return { label: 'none', text: '' };
}

/** Whether the protocol's category lends (its follow-up borrows, so the plan prices interest). */
export function isLending(p: SnapshotProtocol): boolean {
  const c = (p.category ?? '').toLowerCase();
  return c.includes('lend') || c.includes('cdp') || c.includes('collateral');
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A short money figure for prose: $1.23B, $45.6M, $12.3K or $250. */
export function fmtMoney(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
}

/** An exact small-dollar figure: $12.00, $0.40, $262.40. */
export function fmtUsd2(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** The plan's computed inputs, derived from the row's own numbers in buildBoard. */
export interface PlanInputs {
  implied: number;
  low: number;
  high: number;
  deposit: number;
  gas: number;
  bridge: number;
  borrow: number;
  interest: number;
  fees: number;
  maxExposure: number;
  flag: RiskFlag;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second, category-specific action so the wallet shows repeat use, not one deposit. */
function categoryFollowUp(p: SnapshotProtocol, inp: PlanInputs): FarmStep {
  const c = (p.category ?? '').toLowerCase();
  const g = fmtUsd2(inp.gas);
  if (isLending(p)) {
    return { text: `Borrow $${inp.borrow} against the supplied collateral once (25% of the $${inp.deposit} deposit), then repay it within a week, so the position shows both sides of the market.`, cost: `${fmtUsd2(inp.interest)} of interest for one week at 10% APR (assumption) plus ${g} of gas`, time: '10 minutes' };
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) {
    return { text: `Set a reminder to check the pool's range weekly and rebalance if the price moves 20% from entry; one rebalance costs ${g} of gas.`, cost: `${g} of gas per rebalance`, time: '10 minutes a week' };
  }
  if (c.includes('bridge')) {
    return { text: `Use the bridged funds in the destination app within the same week, so the bridge is not the only action on record; the app fee runs about ${g}.`, cost: `${g} of gas`, time: '10 minutes' };
  }
  if (c.includes('staking') || c.includes('restak')) {
    return { text: `Check the points or rewards page each epoch; restaked positions usually accrue per epoch, not per day.`, cost: `${g} of gas to check on-chain`, time: '5 minutes a week' };
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return { text: `Close the hedge after a week and note the funding paid; a small net cost is normal for a qualifying position.`, cost: `${g} of gas to close`, time: '10 minutes' };
  }
  if (c.includes('rwa')) {
    return { text: `Verify the yield asset's backing on the protocol's own page before adding more capital.`, cost: `${g} of gas if you add`, time: '10 minutes' };
  }
  if (c.includes('stable')) {
    return { text: `Check the peg on the protocol's own page weekly; a stable asset that slips is a reason to exit, not to add.`, cost: `${g} of gas to exit`, time: '5 minutes a week' };
  }
  if (c.includes('prediction')) {
    return { text: `Settle or close the market position after it resolves; an open position that never settles counts for nothing.`, cost: `${g} of gas to settle`, time: '10 minutes' };
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return { text: `Read the vault's strategy note each month; a vault that changes strategy is a new position, not the same one.`, cost: `${g} of gas if you switch vaults`, time: '10 minutes a month' };
  }
  if (c.includes('insurance')) {
    return { text: `Read the cover terms once: which events pay out and what the claim window is.`, cost: `${g} of gas if you claim`, time: '10 minutes' };
  }
  return { text: `Do one more on-protocol action in the first week — a swap, a vote or a second deposit — so the wallet shows repeat use.`, cost: `${g} of gas`, time: '10 minutes' };
}

/** The chain's own gas and bridging note, from the protocol's first chain, with computed fees. */
function chainStep(p: SnapshotProtocol, chain: string, inp: PlanInputs): FarmStep {
  const c = chain.toLowerCase();
  const g = fmtUsd2(inp.gas);
  const setupFees = fmtUsd2(3 * inp.gas + inp.bridge);
  const setupTotal = fmtMoney(inp.deposit + 3 * inp.gas + inp.bridge);
  if (c === 'ethereum') {
    return { text: `Do the position on Ethereum mainnet, where gas runs about ${g} per transaction: batch the setup into one session and avoid peak hours. Setup so far: ${setupTotal} (${fmtMoney(inp.deposit)} deposit + ${setupFees} fees).`, cost: `${g} of gas per transaction`, time: '15 minutes' };
  }
  if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].includes(c)) {
    return { text: `Bridge once from Ethereum to ${chain} for ${fmtUsd2(inp.bridge)} and do everything on the L2, where gas is ${g} per transaction. Setup so far: ${setupTotal} (${fmtMoney(inp.deposit)} deposit + ${setupFees} fees).`, cost: `${fmtUsd2(inp.bridge)} bridge fee plus ${g} of gas`, time: '20 minutes' };
  }
  if (c === 'solana') {
    return { text: `On Solana each transaction costs ${g}, so the position itself is the cost: move the funds once (${fmtUsd2(inp.bridge)} bridge) and act in one session. Setup so far: ${setupTotal}.`, cost: `${g} of gas per transaction`, time: '5 minutes' };
  }
  if (c === 'bitcoin') {
    return { text: `On Bitcoin, use only the route the protocol itself publishes; never send BTC to an address the protocol never lists. One transfer costs about ${g}. Setup so far: ${setupTotal}.`, cost: `${g} network fee for one transfer`, time: '15 minutes' };
  }
  return { text: `Check ${chain} gas before the first transaction: about ${g} each, so the setup fees stay under ${fmtUsd2(3 * inp.gas + inp.bridge)}. Setup so far: ${setupTotal}.`, cost: `${g} of gas per transaction`, time: '5 minutes' };
}

/** The "why this protocol" line: one sentence from the protocol's own snapshot record, with the
 * implied value, its interval, the deposit sizing and the risk flag — every figure computed. */
function whyLine(p: SnapshotProtocol, age: number | null, inp: PlanInputs, implied: number): string {
  const cat = p.category ?? 'an unlisted category';
  const chainList = p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'an unnamed chain';
  const ageTxt = age === null ? 'an unlisted age' : age < 365 ? `${age} days` : `${(age / 365).toFixed(1)} years`;
  const growth = p.change_7d === null ? 'no 7-day change on record' : `${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in 7 days`;
  const pct = ((inp.deposit / inp.low) * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  let flag = '';
  if (inp.flag.label !== 'none') flag = ` Risk: ${inp.flag.text}.`;
  return `Why ${p.name}: ${cat} on ${chainList}, ${fmtMoney(p.tvl_usd)} TVL, ${ageTxt} with no token, ${growth}. Implied value ${fmtMoney(implied)} (50% interval ${fmtMoney(inp.low)}–${fmtMoney(inp.high)}).${flag}`;
}

/** The monitor-only plan for a protocol whose token launch is unlikely: watch, do not farm. */
function monitorSteps(p: SnapshotProtocol, age: number | null, inp: PlanInputs, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const pool = Math.max(1, Math.round(implied * FARMER_ALLOCATION));
  const lo20 = fmtMoney(Math.round(p.tvl_usd * 0.8));
  const hi20 = fmtMoney(Math.round(p.tvl_usd * 1.2));
  const catNote =
    p.category === 'CEX'
      ? `An exchange token would list on its own venue; the ${fmtMoney(implied)} value prices its ${fmtMoney(p.tvl_usd)} TVL, not a farmable position.`
      : (p.category ?? '').toLowerCase().includes('bridge')
        ? `Bridges move value between chains; they rarely airdrop to bridgers, so the ${fmtMoney(pool)} farmer pool below assumes a launch that may never come.`
        : (p.category ?? '').toLowerCase().includes('stak')
          ? `A staking wrapper's token, if any, belongs to the staked asset's issuer, not to this wrapper's TVL of ${fmtMoney(p.tvl_usd)}.`
          : `This category rarely launches its own token; the ${fmtMoney(implied)} value is a pricing exercise, not a farm target.`;
  const flagTxt = inp.flag.label === 'none' ? 'no risk flag on this row' : `Risk: ${inp.flag.text}`;
  return [
    { text: `${whyLine(p, age, inp, implied)} Launch: unlikely — monitor only (${p.category ?? 'unlisted category'}).`, cost: '$0 deposit planned', time: '2 minutes' },
    { text: `Do not deposit: $0 in, $0 gas. Watch only — a ${p.category ?? 'protocol'} position earns nothing until a token is actually announced.`, cost: '$0 at risk', time: '5 minutes' },
    { text: `Track TVL monthly: now ${fmtMoney(p.tvl_usd)}. A 20% move is ${lo20}–${hi20}; only a sustained move changes the ${fmtMoney(implied)} implied value.`, cost: '$0 to check', time: '5 minutes a month' },
    { text: `Check the points or rewards page each month; if a token is announced, the ${fmtMoney(implied)} implied value (range ${fmtMoney(inp.low)}–${fmtMoney(inp.high)}) caps any later farm: max deposit would be ${fmtMoney(inp.deposit)}.`, cost: `$0 to check; ${fmtMoney(inp.deposit)} ceiling if launched`, time: '10 minutes a month' },
    { text: `If a launch is announced, acting on ${chain} costs ${fmtUsd2(inp.gas)} per transaction${inp.bridge > 0 ? ` plus a ${fmtUsd2(inp.bridge)} bridge` : ''} — price the farm then, not now.`, cost: `${fmtUsd2(inp.gas)} per transaction if you act`, time: '5 minutes' },
    { text: catNote, cost: `${fmtMoney(pool)} hypothetical pool; $0 committed`, time: '5 minutes' },
    { text: `Re-check in 30 days: TVL ${fmtMoney(p.tvl_usd)}, implied ${fmtMoney(implied)}.`, cost: '$0 to re-check', time: '5 minutes' },
    { text: `${flagTxt} — max exposure stays $0 while monitoring.`, cost: '$0 max exposure', time: '5 minutes' },
    { text: `If ${p.name} ever launched a token at its ${fmtMoney(implied)} implied value, a 10% farmer pool would be ${fmtMoney(pool)} — assumption: first user airdrops gave 5% (Optimism), 11.62% (Arbitrum), 15% (Uniswap), 17.5% (ZKsync). The pool is shared by all farmers; no per-wallet promise.`, cost: `${fmtMoney(pool)} pool if launched; $0 to check, never pay to claim`, time: '10 minutes' },
    { text: `Log the dates and TVL checks in a farm log. $0 spent; $0 at risk; implied ${fmtMoney(implied)} on file.`, cost: '$0 spent', time: '5 minutes' },
  ];
}

/**
 * A protocol's farm plan: ten steps, each an action with a cost and a time. Every dollar figure
 * is computed from the row's own numbers — implied value, interval low/high, TVL-tier deposit,
 * chain gas x transaction count, bridge fee, borrow interest, running fee totals — never a
 * template constant repeated across rows. Monitor-only rows get the watch plan instead.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, deadInCategory = 0, inp?: PlanInputs): FarmStep[] {
  const chain = chainOf(p);
  const flag = inp?.flag ?? riskFlag(p, age, deadInCategory);
  const deposit = inp?.deposit ?? depositFor(p);
  const gas = inp?.gas ?? gasPerTx(chain);
  const bridge = inp?.bridge ?? bridgeFee(chain);
  const borrow = inp?.borrow ?? Math.round(deposit * 0.25);
  const interest = inp?.interest ?? Math.round(((borrow * 0.1) / 52) * 100) / 100;
  const fees = inp?.fees ?? Math.round((9 * gas + bridge + (isLending(p) ? interest : 0)) * 100) / 100;
  const maxExposure = inp?.maxExposure ?? (flag.label === 'none' ? deposit * 2 : deposit);
  const full: PlanInputs = { implied: inp?.implied ?? 0, low: inp?.low ?? 0, high: inp?.high ?? 0, deposit, gas, bridge, borrow, interest, fees, maxExposure, flag };
  const hold = holdDaysFor(age);
  if (plausibilityFor(p) === 'monitor-only') return monitorSteps(p, age, full, full.implied);
  return farmStepsFor(p, age, full, hold);
}

/** The farmable ten steps: why, wallet, action, follow-up, chain, size, weekly, hold, claim, log.
 * Every step carries at least one dollar figure computed from this row (see farmSteps). */
function farmStepsFor(p: SnapshotProtocol, age: number | null, inp: PlanInputs, hold: number): FarmStep[] {
  const chain = chainOf(p);
  const pool = Math.max(1, Math.round(inp.implied * FARMER_ALLOCATION));
  const pct = ((inp.deposit / inp.low) * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  const setupFees = 3 * inp.gas + inp.bridge;
  const weeklyFees = 4 * inp.gas;
  const runningFees = setupFees + weeklyFees;
  const action = actionFor(p, inp.deposit, chain);
  const size =
    p.tvl_usd >= 1_000_000_000
      ? { text: `This is a large protocol: split the $${inp.deposit} across two wallets ($${inp.deposit / 2} each) so no single wallet looks like a whale and both qualify.`, cost: `$${inp.deposit} split as $${inp.deposit / 2} + $${inp.deposit / 2}`, time: '10 minutes' }
      : p.tvl_usd >= 100_000_000
        ? { text: `At this size the protocol is established: one wallet and the full $${inp.deposit} is enough, and extra wallets add nothing.`, cost: `$${inp.deposit} in one wallet`, time: '5 minutes' }
        : { text: `This is a small protocol: keep the position at $${inp.deposit} and re-check its TVL monthly — early protocols change fast, and a shrinking TVL is a reason to exit.`, cost: `$${inp.deposit} stays in the position`, time: '5 minutes a month' };
  return [
    { text: `${whyLine(p, age, inp, inp.implied)} Launch: farmable.`, cost: `$${inp.deposit} planned deposit (${pct}% of the ${fmtMoney(inp.low)} interval low)`, time: '2 minutes' },
    { text: `Use a fresh wallet that holds only the $${inp.deposit} you plan to farm, and keep its seed phrase offline.`, cost: `${fmtUsd2(inp.gas)} of gas for 1 transaction on ${chain}`, time: '5 minutes' },
    { text: action, cost: `$${inp.deposit} of capital and ${fmtUsd2(inp.gas)} of gas, ${fmtMoney(inp.deposit + inp.gas)} total`, time: '15 minutes to set up' },
    categoryFollowUp(p, inp),
    chainStep(p, chain, inp),
    size,
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote. Four weeks cost ${fmtUsd2(weeklyFees)} at ${fmtUsd2(inp.gas)} a week; running fees reach ${fmtUsd2(runningFees)}.`, cost: `${fmtUsd2(weeklyFees)} of gas for 4 weeks`, time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Max exposure ${fmtMoney(inp.maxExposure)}${inp.flag.label === 'none' ? ' (no risk flag: up to 2x the deposit)' : ` (risk flag ${inp.flag.label}: capped at the deposit)`}.`, cost: `${fmtMoney(inp.maxExposure)} max exposure; $${inp.deposit} stays in the position`, time: `${hold} days` },
    { text: `If ${p.name} launched a token at its ${fmtMoney(inp.implied)} implied value, a 10% farmer pool would be ${fmtMoney(pool)} — assumption: first user airdrops gave 5% (Optimism), 11.62% (Arbitrum), 15% (Uniswap), 17.5% (ZKsync). The pool is shared by all farmers; no per-wallet promise.`, cost: `${fmtMoney(pool)} pool if launched; $0 to check, never pay to claim`, time: '10 minutes' },
    { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Then write the wallet, the dates and every transaction in a farm log.`, cost: `${fmtUsd2(inp.gas)} exit gas; ${fmtUsd2(inp.fees)} total fees on a $${inp.deposit} position`, time: '5 minutes' },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    interval_low_usd: row.interval_low_usd,
    interval_high_usd: row.interval_high_usd,
    deposit_usd: row.deposit_usd,
    farmer_pool_usd: row.farmer_pool_usd,
    total_fees_usd: row.total_fees_usd,
    max_exposure_usd: row.max_exposure_usd,
    risk_label: row.risk_label,
    plausibility: row.plausibility,
  };
}

/** Measured farm-plan specificity of a board (mechanical, from the board's own farm_steps):
 * mean dollar figures per plan, mean ROW-SPECIFIC dollar figures per plan (a figure counts as
 * row-specific when its exact $ token appears in at most 5% of rows' plans — template constants
 * like a $150 tier cap repeat everywhere, computed values like an interval low do not), and the
 * share of steps carrying at least one dollar figure. */
export function planSpecificity(board: BoardRow[]): { plan_usd_mean: number; plan_usd_rowspecific_mean: number; plan_steps_with_usd_pct: number } {
  const tokenRe = /\$[\d,]+(?:\.\d+)?[BMK]?/g;
  const globalCount = new Map<string, number>();
  const perRow: string[][] = [];
  let total = 0;
  let steps = 0;
  let stepsWith = 0;
  for (const r of board) {
    const tokens: string[] = [];
    for (const s of r.farm_steps) {
      steps++;
      const m = s.match(tokenRe) ?? [];
      if (m.length > 0) stepsWith++;
      for (const t of m) {
        tokens.push(t);
        globalCount.set(t, (globalCount.get(t) ?? 0) + 1);
      }
    }
    total += tokens.length;
    perRow.push(tokens);
  }
  const threshold = Math.max(1, Math.ceil(board.length * 0.05));
  let specific = 0;
  for (const tokens of perRow) specific += tokens.filter((t) => (globalCount.get(t) ?? 0) <= threshold).length;
  return {
    plan_usd_mean: Math.round((total / board.length) * 100) / 100,
    plan_usd_rowspecific_mean: Math.round((specific / board.length) * 100) / 100,
    plan_steps_with_usd_pct: Math.round((stepsWith / steps) * 1000) / 10,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  // Fit the size curve from this snapshot's own token-bearing protocols before scoring anything.
  const fit = fitSizeModel(snapshot, model);
  const fitted: ModelConstants = { ...model, size_intercept: fit.intercept, size_slope: fit.slope, size_n: fit.n, size_r2: fit.r2 };
  const { bands, coverage_loo } = intervalBands(snapshot, fitted);
  const board = buildBoard(snapshot, fitted, bands);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  // Backtest the fitted model on the snapshot's own token-bearing peers: the same impliedValue
  // function, scored against each peer's realised market cap. Mean |log10 error|.
  const peers = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const fitMae =
    peers.reduce((a, p) => a + Math.abs(Math.log10(impliedValue(p, snapshot.as_of, fitted).implied) - Math.log10(p.mcap_usd!)), 0) / peers.length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: fitted,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    fit_mae: Math.round(fitMae * 1e4) / 1e4,
    fit_cv_mae: Math.round(crossValidatedMae(snapshot, fitted) * 1e4) / 1e4,
    fit_bins: fitBins(snapshot),
    cat_bench: categoryBench(snapshot),
    interval_bands: bands,
    interval_coverage_loo: coverage_loo,
    ...planSpecificity(board),
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
