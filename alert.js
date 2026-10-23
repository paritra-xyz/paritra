// Paritra premium/discount alerts for Telegram.
// Runs on GitHub Actions every 15 minutes. No secrets in this file:
// the bot token comes from the TELEGRAM_BOT_TOKEN repository secret.
const fs = require('node:fs');

// ===== SETTINGS =====
const CHAT_ID = process.env.CHAT_ID || '@paritrachat'; // public group username
const ALERT_AT = 1.5;          // alert when |premium| is at least this many percent
const MIN_LIQUIDITY = 25000;   // ignore pools with less liquidity (USD)
const COOLDOWN_HOURS = 4;      // at most one alert per token in this window...
const REALERT_STEP = 1.0;      // ...unless the gap grew by this many more points
const SUMMARY_UTC_HOUR = 13;   // daily summary around 13:00 UTC (20:00 WIB)
const MAX_FEED_AGE_DAYS = 4;   // skip fair values older than this
// ====================

const TOKENS = [
  ['TSLA', 'Tesla', '0x322F0929c4625eD5bAd873c95208D54E1c003b2d'],
  ['NVDA', 'NVIDIA', '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC'],
  ['AAPL', 'Apple', '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9'],
  ['MSFT', 'Microsoft', '0xe93237C50D904957Cf27E7B1133b510C669c2e74'],
  ['AMZN', 'Amazon', '0x12f190a9F9d7D37a250758b26824B97CE941bF54'],
  ['META', 'Meta Platforms', '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35'],
  ['GOOGL', 'Alphabet', '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3'],
  ['MSTR', 'MicroStrategy', '0xec262a75e413fAfD0dF80480274532C79D42da09'],
  ['SPY', 'S&P 500 ETF', '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C'],
  ['QCOM', 'Qualcomm', '0x0f17206447090e464C277571124dD2688E48AEA9'],
];
const RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.nodeflare.app/robinhood/public'];
const DIRECTORY = 'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json';
const STATE_FILE = 'alerts-state.json';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST = process.env.TEST_MESSAGE === 'true';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { last: {}, summaryDay: '' };
let changed = false;

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

/* ---- DEX prices (GeckoTerminal) ---- */
async function dexPrices() {
  const url = 'https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/multi/' + TOKENS.map((t) => t[2]).join(',');
  const j = await getJSON(url, { headers: { accept: 'application/json' } });
  const out = {};
  for (const tok of j.data || []) {
    const a = tok.attributes || {};
    out[String(a.address).toLowerCase()] = { price: parseFloat(a.price_usd), liq: parseFloat(a.total_reserve_in_usd) || 0 };
  }
  return out;
}

/* ---- Fair value (Chainlink, read on-chain) ---- */
function tickerMatches(text, sym) {
  const base = String(text || '').split('/')[0].toUpperCase().replace(/ROBINHOOD|TOKENI[SZ]ED|STOCK|TOKEN/g, '').replace(/[^A-Z0-9]/g, '');
  return base === sym || base === sym + 'RH' || base === sym + 'X' || base === 'RH' + sym;
}
async function findFeeds() {
  const list = await getJSON(DIRECTORY);
  const feeds = {};
  for (const f of Array.isArray(list) ? list : []) {
    const name = String(f.name || '');
    const addr = f.proxyAddress || f.contractAddress;
    if (!addr || !name.includes('/') || !/USD/.test(name.split('/')[1] || '')) continue;
    for (const t of TOKENS) {
      if (!tickerMatches(name, t[0])) continue;
      const tokenized = /robinhood|tokeni[sz]ed/i.test(JSON.stringify(f));
      const prev = feeds[t[0]];
      if (!prev || (tokenized && !prev.tokenized)) feeds[t[0]] = { addr, dec: f.decimals != null ? +f.decimals : 8, tokenized };
    }
  }
  return feeds;
}
async function ethCall(to, data) {
  for (const rpc of RPCS) {
    try {
      const j = await getJSON(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }) });
      if (typeof j.result === 'string' && j.result.length > 2) return j.result;
    } catch (e) { /* try next endpoint */ }
    await sleep(600);
  }
  return null;
}
async function fairValues(feeds) {
  const out = {};
  for (const sym of Object.keys(feeds)) {
    const hex = await ethCall(feeds[sym].addr, '0xfeaf968c'); // latestRoundData()
    await sleep(600);
    if (!hex || hex.length < 2 + 64 * 5) continue;
    const word = (i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
    const ans = BigInt('0x' + word(1));
    const updated = parseInt(word(3), 16);
    if (ans <= 0n) continue;
    out[sym] = { value: Number(ans) / 10 ** feeds[sym].dec, updated };
  }
  return out;
}

/* ---- helpers ---- */
function marketOpen() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const get = (k) => (p.find((q) => q.type === k) || {}).value || '';
  const mins = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(get('weekday')) && mins >= 570 && mins < 960;
}
const usd = (v) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
async function send(text) {
  if (!TOKEN) { console.log('[no token] would send:\n' + text); return; }
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
}

/* ---- main ---- */
const FOOT = '\n\n<a href="https://paritra.xyz/board">paritra.xyz/board</a>\n<i>Data, not financial advice.</i>';

async function main() {
if (TEST) {
  await send('✅ <b>Paritra alerts are connected.</b>\nThis group will get a message when a verified stock token trades far from its Chainlink fair value.' + FOOT);
  console.log('Test message sent.');
  process.exit(0);
}

const [dex, feeds] = await Promise.all([dexPrices(), findFeeds()]);
const fair = await fairValues(feeds);
const now = Date.now() / 1000;
const open = marketOpen();
const rows = [];
for (const [sym, name, addr] of TOKENS) {
  const d = dex[addr.toLowerCase()], f = fair[sym];
  if (!d || !f || !(d.price > 0)) continue;
  if (now - f.updated > MAX_FEED_AGE_DAYS * 86400) continue;
  rows.push({ sym, name, dex: d.price, liq: d.liq, fair: f.value, prem: (d.price - f.value) / f.value * 100 });
}
console.log('Checked', rows.length, 'tokens:', rows.map((r) => r.sym + ' ' + pct(r.prem)).join(', '));

for (const r of rows) {
  if (Math.abs(r.prem) < ALERT_AT || r.liq < MIN_LIQUIDITY) continue;
  const last = state.last[r.sym];
  const recent = last && now - last.t < COOLDOWN_HOURS * 3600;
  if (recent && Math.abs(r.prem) < Math.abs(last.p) + REALERT_STEP) continue;
  const side = r.prem > 0 ? 'ABOVE' : 'BELOW';
  const icon = r.prem > 0 ? '🟢' : '🔴';
  await send(
    `${icon} <b>Paritra alert · ${r.sym}</b>\n` +
    `${r.name} token is trading <b>${pct(r.prem)}</b> ${side} fair value.\n\n` +
    `DEX price: ${usd(r.dex)}\nFair value: ${usd(r.fair)}\nUS market: ${open ? 'Open' : 'Closed'}` + FOOT
  );
  state.last[r.sym] = { t: now, p: r.prem };
  changed = true;
  await sleep(1200);
}

const today = new Date().toISOString().slice(0, 10);
if (new Date().getUTCHours() === SUMMARY_UTC_HOUR && state.summaryDay !== today && rows.length) {
  const sorted = [...rows].sort((a, b) => b.prem - a.prem);
  const top = sorted[0], bottom = sorted[sorted.length - 1];
  const lines = sorted.map((r) => `${r.sym.padEnd(5, ' ')} ${pct(r.prem)}`).join('\n');
  await send(
    `📊 <b>Daily parity check</b>\n` +
    `Biggest premium: <b>${top.sym} ${pct(top.prem)}</b>\nBiggest discount: <b>${bottom.sym} ${pct(bottom.prem)}</b>\n\n<pre>${lines}</pre>` + FOOT
  );
  state.summaryDay = today;
  changed = true;
}

if (changed) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
console.log(changed ? 'State updated.' : 'Nothing to send.');
}

main().catch((e) => { console.error(e); process.exit(1); });
