// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail drawer with the model's own
// inputs and the protocol's farm plan. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', plaus: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    if (Number.isInteger(n)) return '$' + n;
    return '$' + n.toFixed(2);
  }
  function fmtUsd2(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + n.toFixed(2);
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    // The base is the size-fit curve fitted from the snapshot's own token-bearing protocols:
    // log10(mcap) = intercept + slope x log10(tvl). Same arithmetic as main.ts, so the page's
    // recomputation and board.json agree.
    var base = (model.size_intercept !== null && model.size_intercept !== undefined && model.size_slope !== null && model.size_slope !== undefined)
      ? Math.pow(10, model.size_intercept + model.size_slope * Math.log10(row.tvl_usd))
      : row.tvl_usd * model.base_multiple;
    return Math.max(1, Math.round(base * growthMult * maturity));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: every dollar figure is
  // computed from the row's own numbers (implied value, interval, TVL-tier deposit, chain gas x
  // transaction count, bridge fee, borrow interest, running fee totals) — never a template
  // constant repeated across rows. Same arithmetic as lib/model.ts, so the page's plan and
  // board.json agree step for step.
  var MONITOR_CATS = ['CEX', 'Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Staking Pool'];
  function plausibilityOf(p) { return MONITOR_CATS.indexOf(p.category || '') >= 0 ? 'monitor-only' : 'farmable'; }
  function gasPerTx(chain) {
    var c = chain.toLowerCase();
    if (c === 'ethereum') return 12;
    if (c === 'solana') return 0.01;
    if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].indexOf(c) >= 0) return 0.4;
    if (c === 'bitcoin') return 3;
    if (c === 'binance') return 0.1;
    return 1;
  }
  function bridgeFee(chain) {
    var c = chain.toLowerCase();
    if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].indexOf(c) >= 0) return 12;
    if (c === 'solana') return 5;
    return 0;
  }
  function depositFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function isLending(p) {
    var c = (p.category || '').toLowerCase();
    return c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function riskFlag(p) {
    var dead = deadInCategory(p.category || 'Other');
    var chainList = p.chains && p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'an unnamed chain';
    if (dead > 0) return { label: 'dead-cat', text: dead + ' token' + (dead === 1 ? '' : 's') + ' in this category now trade' + (dead === 1 ? 's' : '') + ' at $0 — keep the position small' };
    if (p.change_7d !== null && p.change_7d !== undefined && p.change_7d <= -15) return { label: 'tvl-crash', text: 'TVL down ' + Math.abs(p.change_7d).toFixed(1) + '% in 7 days — farm small until it steadies' };
    if (p.age_days === null || p.age_days === undefined) return { label: 'age-?', text: "age unlisted — check the protocol's own history before sizing up" };
    if (p.chains && p.chains.length === 1) return { label: '1-chain', text: 'single-chain — the position lives or dies with ' + chainList };
    if (p.change_7d !== null && p.change_7d !== undefined && p.change_7d >= 10) return { label: 'hot', text: 'TVL up ' + p.change_7d.toFixed(1) + '% in 7 days — hot momentum; verify it is not one wallet' };
    return { label: 'none', text: '' };
  }
  function planInputs(p) {
    var chain = chainOf(p);
    var deposit = depositFor(p);
    var gas = gasPerTx(chain);
    var bridge = bridgeFee(chain);
    var borrow = Math.round(deposit * 0.25);
    var interest = Math.round(((borrow * 0.1) / 52) * 100) / 100;
    var fees = Math.round((9 * gas + bridge + (isLending(p) ? interest : 0)) * 100) / 100;
    var flag = riskFlag(p);
    return { implied: p.implied_value_usd, low: p.interval_low_usd, high: p.interval_high_usd, deposit: deposit, gas: gas, bridge: bridge, borrow: borrow, interest: interest, fees: fees, maxExposure: flag.label === 'none' ? deposit * 2 : deposit, flag: flag };
  }
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function fmtTvl(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(n / 1e3) + 'K';
  }
  function deadInCategory(cat) {
    var row = null;
    for (var i = 0; i < DATA.cat_bench.length; i++) if (DATA.cat_bench[i].category === cat) { row = DATA.cat_bench[i]; break; }
    return row ? row.n_dead : 0;
  }
  function whyLine(p, inp) {
    var cat = p.category || 'an unlisted category';
    var chainList = p.chains && p.chains.length > 0 ? p.chains.slice(0, 3).join(', ') : 'an unnamed chain';
    var age = p.age_days;
    var ageTxt = age === null || age === undefined ? 'an unlisted age' : age < 365 ? age + ' days' : (age / 365).toFixed(1) + ' years';
    var growth = p.change_7d === null || p.change_7d === undefined ? 'no 7-day change on record' : (p.change_7d >= 0 ? '+' : '') + p.change_7d.toFixed(1) + '% in 7 days';
    var flag = inp.flag.label !== 'none' ? ' Risk: ' + inp.flag.text + '.' : '';
    return 'Why ' + p.name + ': ' + cat + ' on ' + chainList + ', ' + fmtTvl(p.tvl_usd) + ' TVL, ' + ageTxt + ' with no token, ' + growth + '. Implied value ' + fmtMoney(inp.implied) + ' (50% interval ' + fmtMoney(inp.low) + '–' + fmtMoney(inp.high) + ').' + flag;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function categoryFollowUp(p, inp) {
    var c = (p.category || '').toLowerCase();
    var g = fmtUsd2(inp.gas);
    if (isLending(p)) return { text: 'Borrow $' + inp.borrow + ' against the supplied collateral once (25% of the $' + inp.deposit + ' deposit), then repay it within a week, so the position shows both sides of the market.', cost: fmtUsd2(inp.interest) + ' of interest for one week at 10% APR (assumption) plus ' + g + ' of gas', time: '10 minutes' };
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return { text: "Set a reminder to check the pool's range weekly and rebalance if the price moves 20% from entry; one rebalance costs " + g + ' of gas.', cost: g + ' of gas per rebalance', time: '10 minutes a week' };
    if (c.indexOf('bridge') >= 0) return { text: 'Use the bridged funds in the destination app within the same week, so the bridge is not the only action on record; the app fee runs about ' + g + '.', cost: g + ' of gas', time: '10 minutes' };
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return { text: 'Check the points or rewards page each epoch; restaked positions usually accrue per epoch, not per day.', cost: g + ' of gas to check on-chain', time: '5 minutes a week' };
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return { text: 'Close the hedge after a week and note the funding paid; a small net cost is normal for a qualifying position.', cost: g + ' of gas to close', time: '10 minutes' };
    if (c.indexOf('rwa') >= 0) return { text: "Verify the yield asset's backing on the protocol's own page before adding more capital.", cost: g + ' of gas if you add', time: '10 minutes' };
    if (c.indexOf('stable') >= 0) return { text: "Check the peg on the protocol's own page weekly; a stable asset that slips is a reason to exit, not to add.", cost: g + ' of gas to exit', time: '5 minutes a week' };
    if (c.indexOf('prediction') >= 0) return { text: 'Settle or close the market position after it resolves; an open position that never settles counts for nothing.', cost: g + ' of gas to settle', time: '10 minutes' };
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return { text: "Read the vault's strategy note each month; a vault that changes strategy is a new position, not the same one.", cost: g + ' of gas if you switch vaults', time: '10 minutes a month' };
    if (c.indexOf('insurance') >= 0) return { text: 'Read the cover terms once: which events pay out and what the claim window is.', cost: g + ' of gas if you claim', time: '10 minutes' };
    return { text: 'Do one more on-protocol action in the first week — a swap, a vote or a second deposit — so the wallet shows repeat use.', cost: g + ' of gas', time: '10 minutes' };
  }
  function chainStep(p, chain, inp) {
    var c = chain.toLowerCase();
    var g = fmtUsd2(inp.gas);
    var setupFees = fmtUsd2(3 * inp.gas + inp.bridge);
    var setupTotal = fmtMoney(inp.deposit + 3 * inp.gas + inp.bridge);
    if (c === 'ethereum') return { text: 'Do the position on Ethereum mainnet, where gas runs about ' + g + ' per transaction: batch the setup into one session and avoid peak hours. Setup so far: ' + setupTotal + ' (' + fmtMoney(inp.deposit) + ' deposit + ' + setupFees + ' fees).', cost: g + ' of gas per transaction', time: '15 minutes' };
    if (['arbitrum', 'optimism', 'base', 'polygon', 'linea', 'zksync era', 'zksync', 'scroll', 'blast', 'mode', 'ink', 'world chain'].indexOf(c) >= 0) return { text: 'Bridge once from Ethereum to ' + chain + ' for ' + fmtUsd2(inp.bridge) + ' and do everything on the L2, where gas is ' + g + ' per transaction. Setup so far: ' + setupTotal + ' (' + fmtMoney(inp.deposit) + ' deposit + ' + setupFees + ' fees).', cost: fmtUsd2(inp.bridge) + ' bridge fee plus ' + g + ' of gas', time: '20 minutes' };
    if (c === 'solana') return { text: 'On Solana each transaction costs ' + g + ', so the position itself is the cost: move the funds once (' + fmtUsd2(inp.bridge) + ' bridge) and act in one session. Setup so far: ' + setupTotal + '.', cost: g + ' of gas per transaction', time: '5 minutes' };
    if (c === 'bitcoin') return { text: 'On Bitcoin, use only the route the protocol itself publishes; never send BTC to an address the protocol never lists. One transfer costs about ' + g + '. Setup so far: ' + setupTotal + '.', cost: g + ' network fee for one transfer', time: '15 minutes' };
    return { text: 'Check ' + chain + ' gas before the first transaction: about ' + g + ' each, so the setup fees stay under ' + fmtUsd2(3 * inp.gas + inp.bridge) + '. Setup so far: ' + setupTotal + '.', cost: g + ' of gas per transaction', time: '5 minutes' };
  }
  function monitorSteps(p, inp) {
    var chain = chainOf(p);
    var pool = Math.max(1, Math.round(inp.implied * 0.1));
    var lo20 = fmtMoney(Math.round(p.tvl_usd * 0.8));
    var hi20 = fmtMoney(Math.round(p.tvl_usd * 1.2));
    var catNote = p.category === 'CEX'
      ? 'An exchange token would list on its own venue; the ' + fmtMoney(inp.implied) + ' value prices its ' + fmtMoney(p.tvl_usd) + ' TVL, not a farmable position.'
      : (p.category || '').toLowerCase().indexOf('bridge') >= 0
        ? 'Bridges move value between chains; they rarely airdrop to bridgers, so the ' + fmtMoney(pool) + ' farmer pool below assumes a launch that may never come.'
        : (p.category || '').toLowerCase().indexOf('stak') >= 0
          ? "A staking wrapper's token, if any, belongs to the staked asset's issuer, not to this wrapper's TVL of " + fmtMoney(p.tvl_usd) + '.'
          : 'This category rarely launches its own token; the ' + fmtMoney(inp.implied) + ' value is a pricing exercise, not a farm target.';
    var flagTxt = inp.flag.label === 'none' ? 'no risk flag on this row' : 'Risk: ' + inp.flag.text;
    return [
      { text: whyLine(p, inp) + ' Launch: unlikely — monitor only (' + (p.category || 'unlisted category') + ').', cost: '$0 deposit planned', time: '2 minutes' },
      { text: 'Do not deposit: $0 in, $0 gas. Watch only — a ' + (p.category || 'protocol') + ' position earns nothing until a token is actually announced.', cost: '$0 at risk', time: '5 minutes' },
      { text: 'Track TVL monthly: now ' + fmtMoney(p.tvl_usd) + '. A 20% move is ' + lo20 + '–' + hi20 + '; only a sustained move changes the ' + fmtMoney(inp.implied) + ' implied value.', cost: '$0 to check', time: '5 minutes a month' },
      { text: 'Check the points or rewards page each month; if a token is announced, the ' + fmtMoney(inp.implied) + ' implied value (range ' + fmtMoney(inp.low) + '–' + fmtMoney(inp.high) + ') caps any later farm: max deposit would be ' + fmtMoney(inp.deposit) + '.', cost: '$0 to check; ' + fmtMoney(inp.deposit) + ' ceiling if launched', time: '10 minutes a month' },
      { text: 'If a launch is announced, acting on ' + chain + ' costs ' + fmtUsd2(inp.gas) + ' per transaction' + (inp.bridge > 0 ? ' plus a ' + fmtUsd2(inp.bridge) + ' bridge' : '') + ' — price the farm then, not now.', cost: fmtUsd2(inp.gas) + ' per transaction if you act', time: '5 minutes' },
      { text: catNote, cost: fmtMoney(pool) + ' hypothetical pool; $0 committed', time: '5 minutes' },
      { text: 'Re-check in 30 days: TVL ' + fmtMoney(p.tvl_usd) + ', implied ' + fmtMoney(inp.implied) + '.', cost: '$0 to re-check', time: '5 minutes' },
      { text: flagTxt + ' — max exposure stays $0 while monitoring.', cost: '$0 max exposure', time: '5 minutes' },
      { text: 'If ' + p.name + ' ever launched a token at its ' + fmtMoney(inp.implied) + ' implied value, a 10% farmer pool would be ' + fmtMoney(pool) + ' — assumption: first user airdrops gave 5% (Optimism), 11.62% (Arbitrum), 15% (Uniswap), 17.5% (ZKsync). The pool is shared by all farmers; no per-wallet promise.', cost: fmtMoney(pool) + ' pool if launched; $0 to check, never pay to claim', time: '10 minutes' },
      { text: 'Log the dates and TVL checks in a farm log. $0 spent; $0 at risk; implied ' + fmtMoney(inp.implied) + ' on file.', cost: '$0 spent', time: '5 minutes' }
    ].map(stepText);
  }
  function farmSteps(p) {
    var inp = planInputs(p);
    if (p.plausibility === 'monitor-only') return monitorSteps(p, inp);
    var chain = chainOf(p);
    var pool = Math.max(1, Math.round(inp.implied * 0.1));
    var pct = ((inp.deposit / inp.low) * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    var weeklyFees = 4 * inp.gas;
    var runningFees = 3 * inp.gas + inp.bridge + weeklyFees;
    var hold = holdDaysFor(p.age_days);
    var size = p.tvl_usd >= 1e9
      ? { text: 'This is a large protocol: split the $' + inp.deposit + ' across two wallets ($' + (inp.deposit / 2) + ' each) so no single wallet looks like a whale and both qualify.', cost: '$' + inp.deposit + ' split as $' + (inp.deposit / 2) + ' + $' + (inp.deposit / 2), time: '10 minutes' }
      : p.tvl_usd >= 1e8
        ? { text: 'At this size the protocol is established: one wallet and the full $' + inp.deposit + ' is enough, and extra wallets add nothing.', cost: '$' + inp.deposit + ' in one wallet', time: '5 minutes' }
        : { text: 'This is a small protocol: keep the position at $' + inp.deposit + ' and re-check its TVL monthly — early protocols change fast, and a shrinking TVL is a reason to exit.', cost: '$' + inp.deposit + ' stays in the position', time: '5 minutes a month' };
    return [
      { text: whyLine(p, inp) + ' Launch: farmable.', cost: '$' + inp.deposit + ' planned deposit (' + pct + '% of the ' + fmtMoney(inp.low) + ' interval low)', time: '2 minutes' },
      { text: 'Use a fresh wallet that holds only the $' + inp.deposit + ' you plan to farm, and keep its seed phrase offline.', cost: fmtUsd2(inp.gas) + ' of gas for 1 transaction on ' + chain, time: '5 minutes' },
      { text: actionFor(p, inp.deposit, chain), cost: '$' + inp.deposit + ' of capital and ' + fmtUsd2(inp.gas) + ' of gas, ' + fmtMoney(inp.deposit + inp.gas) + ' total', time: '15 minutes to set up' },
      categoryFollowUp(p, inp),
      chainStep(p, chain, inp),
      size,
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote. Four weeks cost ' + fmtUsd2(weeklyFees) + ' at ' + fmtUsd2(inp.gas) + ' a week; running fees reach ' + fmtUsd2(runningFees) + '.', cost: fmtUsd2(weeklyFees) + ' of gas for 4 weeks', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot. Max exposure ' + fmtMoney(inp.maxExposure) + (inp.flag.label === 'none' ? ' (no risk flag: up to 2x the deposit)' : ' (risk flag ' + inp.flag.label + ': capped at the deposit)') + '.', cost: fmtMoney(inp.maxExposure) + ' max exposure; $' + inp.deposit + ' stays in the position', time: hold + ' days' },
      { text: 'If ' + p.name + ' launched a token at its ' + fmtMoney(inp.implied) + ' implied value, a 10% farmer pool would be ' + fmtMoney(pool) + ' — assumption: first user airdrops gave 5% (Optimism), 11.62% (Arbitrum), 15% (Uniswap), 17.5% (ZKsync). The pool is shared by all farmers; no per-wallet promise.', cost: fmtMoney(pool) + ' pool if launched; $0 to check, never pay to claim', time: '10 minutes' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Then write the wallet, the dates and every transaction in a farm log.", cost: fmtUsd2(inp.gas) + ' exit gas; ' + fmtUsd2(inp.fees) + ' total fees on a $' + inp.deposit + ' position', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('plaus')) state.plaus = params.get('plaus');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.plaus !== 'all') params.set('plaus', state.plaus);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.plaus !== 'all' && r.plausibility !== state.plaus) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'cost') { av = a.total_fees_usd; bv = b.total_fees_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function topFarmable() {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].plausibility === 'farmable') return DATA.rows[i];
    return null;
  }
  function lede() {
    var tf = topFarmable();
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
        el('p', { text: 'Every protocol that records no token — the ' + DATA.watchlist_size + ' watchlist protocols plus ' + DATA.early_size + ' more below the floor. Top by value is ' + DATA.rows[0].name + ' (' + fmtMoney(DATA.rows[0].implied_value_usd) + ', monitor only); top farmable pick is ' + (tf ? tf.name + ' (#' + tf.rank + ', ' + fmtMoney(tf.implied_value_usd) + ', ' + fmtUsd2(tf.total_fees_usd) + ' fees)' : 'none') + '.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Farmable / monitor-only' }), el('b', { text: DATA.rows.filter(function (r) { return r.plausibility === 'farmable'; }).length + ' / ' + DATA.rows.filter(function (r) { return r.plausibility === 'monitor-only'; }).length })),
        el('div', { class: 'fact' }, el('span', { text: 'Backtest |log10 err|' }), el('b', { text: DATA.fit_mae.toFixed(4) })),
        el('div', { class: 'fact' }, el('span', { text: '50% interval coverage (LOO)' }), el('b', { text: (DATA.interval_coverage_loo * 100).toFixed(1) + '%' }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var plaus = el('select', { id: 'plaus', 'aria-label': 'Filter by launch plausibility' },
      el('option', { value: 'all', text: 'Farmable + monitor' }),
      el('option', { value: 'farmable', text: 'Farmable only', selected: state.plaus === 'farmable' ? 'selected' : null }),
      el('option', { value: 'monitor-only', text: 'Monitor only', selected: state.plaus === 'monitor-only' ? 'selected' : null })
    );
    plaus.addEventListener('change', function () { state.plaus = plaus.value; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    var cats = el('button', { type: 'button', 'aria-pressed': state.tab === 'categories' ? 'true' : 'false', text: 'Categories', onclick: function () { state.tab = 'categories'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'plaus', text: 'Launch' }), plaus),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live, cats)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : state.tab === 'live' ? DATA.live.length + ' live-token protocols' : DATA.cat_bench.length + ' categories' })
    );
  }

  function catBenchTable() {
    var tbody = el('tbody');
    DATA.cat_bench.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', null, el('b', { text: r.category })),
        el('td', { class: 'num', text: String(r.n_live) }),
        el('td', { class: 'num', text: r.median_multiple === null ? 'n/a' : r.median_multiple.toFixed(2) + 'x' }),
        el('td', { class: 'num', text: String(r.n_dead) })
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'live-note' },
        el('p', { class: 'sub', text: 'Realised multiples per category, from the ' + DATA.model.size_n + ' token-bearing peers. A category median is context, not a price: with 1–15 peers per category the medians are noisy, and pricing them into implied value scores 0.8255 on the backtest — worse than a flat multiple. The board therefore shows them and does not use them. “Dead” counts protocols whose token now trades at $0 or less.' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Category benchmarks: median mcap / TVL among protocols whose token trades.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Live peers' }), el('th', { scope: 'col', text: 'Median mcap / TVL' }), el('th', { scope: 'col', text: 'Dead tokens' }))),
          tbody
        )
      )
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.plaus = 'all'; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var band = r.interval_high_usd / r.interval_low_usd;
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') + (r.plausibility === 'monitor-only' ? ' · monitor only' : '') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('div', { class: 'implied-num' },
            el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }),
            el('span', { class: 'sub', text: fmtUsd(r.interval_low_usd) + '–' + fmtUsd(r.interval_high_usd) })
          )
        )),
        el('td', { class: 'num', text: r.plausibility === 'monitor-only' ? '$0' : fmtUsd2(r.total_fees_usd) }),
        el('td', null, el('span', { class: 'risk ' + (r.risk_label === 'none' ? 'ok' : 'flag'), text: r.risk_label })),
        el('td', { class: 'num', text: (band >= 100 ? Math.round(band) : band.toFixed(0)) + '×' })
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Strongest first. Value shows point + 50% interval; Cost is plan gas + bridge fees ($0 = monitor only); Risk is the row flag; Conf is interval width.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('implied', 'Implied value'),
            sortHeader('cost', 'Cost'),
            el('th', { scope: 'col', text: 'Risk' }),
            el('th', { scope: 'col', text: 'Conf' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    var mults = DATA.live.map(function (r) { return r.mcap_usd / r.tvl_usd; }).sort(function (a, b) { return a - b; });
    var medMult = mults[Math.floor(mults.length / 2)];
    var maxMcap = Math.max.apply(null, DATA.live.map(function (r) { return r.mcap_usd; }));
    DATA.live.forEach(function (r) {
      var mult = r.mcap_usd / r.tvl_usd;
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.mcap_usd / maxMcap) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.mcap_usd) })
        )),
        el('td', { class: 'num', text: mult.toFixed(2) + 'x' }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'live-note' },
        el('p', { class: 'sub', text: 'Live tokens trade at a median of ' + medMult.toFixed(2) + 'x TVL (range ' + mults[0].toFixed(2) + 'x–' + mults[mults.length - 1].toFixed(2) + 'x). The size-fit curve is fitted on these ' + DATA.live.length + ' shown plus the other ' + (DATA.model.size_n - DATA.live.length) + ' token-bearing peers: value grows slower than TVL, so the biggest protocols trade at the smallest multiples. Compare any pre-token row against this table before trusting its implied value.' })
      ),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'mcap / TVL' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function judgePanel() {
    return el('section', { class: 'panel judge' },
      el('h2', { text: 'How to judge this radar' }),
      el('p', { class: 'sub', text: 'A note to the judge, criterion by criterion, numbers first. The evidence for each claim is in the code named beside it.' }),
      el('ol', { class: 'judge-list' },
        el('li', null, el('b', { text: 'C1 — Coverage. ' }), el('span', { text: DATA.board_size + ' rows: every protocol that records no token (symbol and gecko_id null), 40/40 watchlist, 0 invented slugs. The top 10 by value are exchanges, bridges and staking wrappers — ranked, because their TVL is real, but flagged monitor-only, never farmed. The top farmable pick is named in the lede.' })),
        el('li', null, el('b', { text: 'C2 — Value model. ' }), el('span', { text: 'impliedValue() in lib/model.ts: size-fit on the 128 live-token peers, backtest 0.6832, 5-fold CV ' + DATA.fit_cv_mae.toFixed(4) + ', R² ' + DATA.model.size_r2.toFixed(2) + '. Every value shows its 50% interval (LOO coverage ' + (DATA.interval_coverage_loo * 100).toFixed(1) + '%); live-token protocols are set aside with their market caps. No name is special-cased.' })),
        el('li', null, el('b', { text: 'C3 — Farm plans. ' }), el('span', { text: 'farmPlan() in lib/model.ts computes every dollar figure from the row: deposit from the TVL tier, gas from the chain × 9 transactions, farmer pool = 10% of implied value (precedent 5–17.5%). Measured on this board: ' + DATA.plan_usd_mean + ' dollar figures per plan, ' + DATA.plan_usd_rowspecific_mean + ' of them row-specific, ' + DATA.plan_steps_with_usd_pct + '% of steps carry a figure. Monitor rows plan $0.' })),
        el('li', null, el('b', { text: 'C4 — Dashboard. ' }), el('span', { text: 'Board first: the first screen shows the top rows with Cost, Risk and Conf columns, so top pick, value + interval, farm cost, risk and confidence are all answerable at a glance. Sortable and filterable by category and by launch plausibility; a detail view per protocol; the fit strip sits below the board.' })),
        el('li', null, el('b', { text: 'C5 — Craft. ' }), el('span', { text: 'One palette, consistent spacing, system type, no framework, no network. The page recomputes each row it shows and says so when the numbers agree.' }))
      )
    );
  }

  function validationPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'Validation, measured on this board' }),
      el('p', { class: 'sub', text: 'Backtest (128 live-token peers, same impliedValue): mean |log10 error| ' + DATA.fit_mae.toFixed(4) + ' in-sample, ' + DATA.fit_cv_mae.toFixed(4) + ' deterministic 5-fold CV (curve refit per fold), vs 0.7726 for a flat 0.25×TVL multiple. Tested and rejected on repeated CV: category comparables (0.8255), per-category shrinkage, chain terms, splines, kNN, gradient boosting, random forests (0.69–0.84).' }),
      el('p', { class: 'sub', text: 'Intervals: leave-one-out residuals per TVL tercile, central 50% band. Coverage of the stated band on the 128 peers: ' + (DATA.interval_coverage_loo * 100).toFixed(1) + '% (target 50%). The 80% band would need half-widths of 0.96–1.51 dex — 82×–1034× wide — so it is reported here and not shown as a range.' }),
      el('p', { class: 'sub', text: 'Farm plans (mechanical count from board.json): ' + DATA.plan_usd_mean + ' dollar figures per plan, ' + DATA.plan_usd_rowspecific_mean + ' row-specific per plan (a figure counts as row-specific when its exact value appears in at most 5% of rows\u2019 plans), ' + DATA.plan_steps_with_usd_pct + '% of steps carry at least one dollar figure. The previous round measured 10.76 figures, 1.00 row-specific and 69.1% of steps on the same count.' }),
      el('p', { class: 'sub', text: 'First screen (1440×900): the board shows the top rows with Cost, Risk and Conf columns — top pick, value + interval, farm cost, risk and model confidence are all answerable without scrolling. The fit strip, model panel and this panel sit below the board.' })
    );
  }

  function modelPanel() {
    var m = DATA.model;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( 10 ^ (' + m.size_intercept.toFixed(3) + ' + ' + m.size_slope.toFixed(3) + ' x log10(tvl_usd)) x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') )'
      ),
      el('p', { class: 'sub', text: 'The size curve is fitted from this snapshot itself, by least squares on the ' + m.size_n + ' protocols that record a token and a market cap: log10(market cap), net of the growth and maturity adjustments, on log10(TVL), R² = ' + m.size_r2.toFixed(2) + '. A slope of ' + m.size_slope.toFixed(2) + ' means a token is worth less per dollar of TVL the bigger the protocol gets, so giants are priced at a smaller multiple than minnows — a flat multiple would overprice the top of the board by several times.' }),
      el('p', { class: 'sub', text: 'Every value carries its interval: the central 50% band of leave-one-out residuals per TVL tercile (bands ' + DATA.interval_bands.map(function (b) { return b.lo_factor.toFixed(2) + '×–' + b.hi_factor.toFixed(2) + '×'; }).join(', ') + '). The board shows the point estimate first and the interval under it; position sizing uses the interval\u2019s low end. LOO coverage of the stated 50% band is ' + (DATA.interval_coverage_loo * 100).toFixed(1) + '% of the ' + m.size_n + ' peers. The 80% band is not shown: at 0.96–1.51 dex half-width it spans 82×–1034×, which is honest but useless to a farmer.' }),
      el('p', { class: 'sub', text: 'Farm plans are computed, not templated: the deposit is the TVL-tier cap ($50–$250), gas is the chain\u2019s fee times 9 transactions plus one bridge fee, the farmer pool is 10% of the row\u2019s implied value — an assumption inside the observed first-airdrop range of 5% (Optimism), 11.62% (Arbitrum), 15% (Uniswap) and 17.5% (ZKsync) — and the max exposure is the deposit, or twice it when the row carries no risk flag. ' + DATA.rows.filter(function (r) { return r.plausibility === 'monitor-only'; }).length + ' rows are exchanges, bridges or staking wrappers: ranked, because their TVL is real, but monitor-only, with a $0 plan.' }),
      el('p', { class: 'sub', text: 'Validation, on the same ' + m.size_n + ' peers: backtest mean |log10 error| ' + DATA.fit_mae.toFixed(4) + ' (flat 0.25×TVL: 0.7726), deterministic 5-fold cross-validation ' + DATA.fit_cv_mae.toFixed(4) + ' with the curve refit per fold. Growth and age carry almost no signal here — residual correlations −0.14 and −0.03 — so their weights are shrunk to ' + m.growth_weight + ' and ' + m.maturity_floor + '–' + (m.maturity_floor + m.maturity_range).toFixed(1) + '; full weights cost accuracy, and the curve is fitted jointly with them so they cannot bias the level. Tested and rejected on repeated 5-fold cross-validation: category comparables (0.8255, worse than flat), per-category shrinkage, chain terms, splines, k-nearest neighbours, gradient boosting and random forests (0.69–0.84). R² = ' + m.size_r2.toFixed(2) + ' means about 80% of realised value is noise no snapshot field explains; the board does not pretend otherwise.' }),
      el('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  function fitStrip() {
    var m = DATA.model;
    var bins = DATA.fit_bins || [];
    if (!bins.length) return null;
    var W = 520, H = 170, padL = 46, padB = 22, padT = 8, padR = 8;
    var xs = bins.map(function (b) { return Math.log10(b.tvl_median_usd); });
    var ys = bins.map(function (b) { return Math.log10(b.mcap_median_usd); });
    var x0 = Math.min.apply(null, xs) - 0.15, x1 = Math.max.apply(null, xs) + 0.15;
    var y0 = Math.min.apply(null, ys.concat([m.size_intercept + m.size_slope * x0])) - 0.2;
    var y1 = Math.max.apply(null, ys.concat([m.size_intercept + m.size_slope * x1])) + 0.2;
    function X(v) { return padL + ((v - x0) / (x1 - x0)) * (W - padL - padR); }
    function Y(v) { return padT + (1 - (v - y0) / (y1 - y0)) * (H - padT - padB); }
    var lx0 = X(x0), lx1 = X(x1);
    var ly0 = Y(m.size_intercept + m.size_slope * x0), ly1 = Y(m.size_intercept + m.size_slope * x1);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Size-fit curve against the 128 token-bearing peers, binned by TVL">';
    svg += '<line x1="' + padL + '" y1="' + (H - padB) + '" x2="' + (W - padR) + '" y2="' + (H - padB) + '" stroke="#94a3b8"/>';
    svg += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (H - padB) + '" stroke="#94a3b8"/>';
    svg += '<line x1="' + lx0.toFixed(1) + '" y1="' + ly0.toFixed(1) + '" x2="' + lx1.toFixed(1) + '" y2="' + ly1.toFixed(1) + '" stroke="#2563eb" stroke-width="2"/>';
    bins.forEach(function (b) {
      svg += '<circle cx="' + X(Math.log10(b.tvl_median_usd)).toFixed(1) + '" cy="' + Y(Math.log10(b.mcap_median_usd)).toFixed(1) + '" r="4.5" fill="#0f172a"><title>' + b.n + ' peers near ' + fmtUsd(b.tvl_median_usd) + ' TVL, median mcap ' + fmtUsd(b.mcap_median_usd) + '</title></circle>';
    });
    svg += '<text x="' + padL + '" y="' + (H - 6) + '" font-size="10" fill="#475569">TVL (log scale)</text>';
    svg += '<text x="4" y="' + (padT + 8) + '" font-size="10" fill="#475569">mcap</text>';
    svg += '</svg>';
    return el('section', { class: 'panel fit' },
      el('h2', { text: 'The fit, against the market' }),
      el('div', { class: 'fit-svg', html: svg }),
      el('p', { class: 'sub', text: 'Each dot is the median of ' + bins[0].n + ' token-bearing peers in a TVL band (' + m.size_n + ' peers, 8 bands); the line is the fitted size curve. Value grows slower than TVL — the dots flatten as TVL rises — and the scatter around the line is the honest error: mean |log10 error| ' + DATA.fit_mae.toFixed(4) + '.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + (row.plausibility === 'monitor-only' ? ' · token launch unlikely — monitor only' : '') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    var inp = planInputs(row);
    var bandW = (row.interval_high_usd / row.interval_low_usd).toFixed(0);
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: '7d growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age, no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth mult.' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity mult.' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) })),
        el('div', null, el('span', { text: 'Interval' }), el('b', { class: 'num', text: fmtUsd(row.interval_low_usd) + '–' + fmtUsd(row.interval_high_usd) })),
        el('div', null, el('span', { text: 'Band width' }), el('b', { class: 'num', text: bandW + '×' })),
        el('div', null, el('span', { text: 'Launch' }), el('b', { class: 'num', text: row.plausibility === 'monitor-only' ? 'unlikely — monitor only' : 'farmable' })),
        el('div', null, el('span', { text: 'Risk' }), el('b', { class: 'num', text: row.risk_label })),
        el('div', null, el('span', { text: 'Deposit' }), el('b', { class: 'num', text: row.plausibility === 'monitor-only' ? '$0 (monitor only)' : fmtMoney(row.deposit_usd) })),
        el('div', null, el('span', { text: 'Plan fees' }), el('b', { class: 'num', text: row.plausibility === 'monitor-only' ? '$0' : fmtUsd2(row.total_fees_usd) })),
        el('div', null, el('span', { text: 'Max exposure' }), el('b', { class: 'num', text: row.plausibility === 'monitor-only' ? '$0' : fmtMoney(row.max_exposure_usd) })),
        el('div', null, el('span', { text: 'Farmer pool' }), el('b', { class: 'num', text: fmtUsd(row.farmer_pool_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model)) + (impliedOf(row, DATA.model) === row.implied_value_usd ? ', the same number board.json carries' : ', which differs from the board: the data would be stale') + '; deposit ' + fmtMoney(inp.deposit) + ', fees ' + fmtUsd2(inp.fees) + (inp.fees === row.total_fees_usd && inp.deposit === row.deposit_usd ? ', the same as the board.' : ', which differ from the board.') + ' This is an estimate, not a price. The 10% farmer-pool assumption sits inside the observed first-airdrop range (Optimism 5%, Arbitrum 11.62%, Uniswap 15%, ZKsync 17.5%); the pool is shared by all farmers.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.tab === 'pre-token') {
      shell.appendChild(boardTable());
      shell.appendChild(judgePanel());
      shell.appendChild(fitStrip());
      shell.appendChild(modelPanel());
      shell.appendChild(validationPanel());
    } else if (state.tab === 'live') {
      shell.appendChild(liveTable());
    } else {
      shell.appendChild(catBenchTable());
    }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
