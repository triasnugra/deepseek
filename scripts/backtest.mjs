#!/usr/bin/env node
// Backtester untuk engine CryptoEliz (core.mjs -> feat). Memakai fungsi feat() yang SAMA dengan
// halaman jurnal dan penilaian trade yang SAMA dengan jurnal live (trade-sim.mjs).
//
// Cara kerja:
//  - Untuk tiap hari i, feat() diberi 999 candle harian yang sudah tutup + candle "berjalan"
//    sintetis berisi hanya harga open hari i (scan tepat 00:00 UTC, tanpa melihat masa depan).
//  - Sinyal yang lolos (side != 0, SL <= maxsl) menjadi order limit yang berlaku `hold` hari,
//    dinilai dengan candle 1H (opsional 1 menit untuk candle yang ambigu).
//  - Hasil dibandingkan dengan 2 baseline: MIRROR (arah dibalik, market di open) dan MARKET
//    (arah sama, market di open, jarak SL/TP sama). Strategi hanya berarti bila mengalahkan keduanya.
//  - Selang kepercayaan memakai bootstrap per blok minggu, karena sinyal di hari yang sama
//    berkorelasi (satu rezim pasar).
//
// Pakai:  node scripts/backtest.mjs --help
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bj, NOT, feat } from '../core.mjs';
import { gradeTrade, mapK } from '../trade-sim.mjs';
import { summarize, bootCI, groupBy, FILLED } from './backtest-lib.mjs';

const DAY = 864e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, n = 3) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await sleep(800 * (i + 1)); } } throw e; }
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); } }));
  return out;
}
const iso = t => new Date(t).toISOString().slice(0, 10);

export const DEFAULTS = {
  top: 40, days: 1500, warmup: 400, fee: 0.05, slip: 0.05, hold: 7, maxsl: 15,
  dedupe: true, boot: 5000, seed: 1, precise: false, refresh: false, symbols: null,
  out: 'backtest/out', cache: 'backtest/cache', conc: 4,
  entry: 'limit', tpMult: null, split: null, fetchHold: null,
};

const HELP = `node scripts/backtest.mjs [opsi]
  --top N        universe: N koin USDT dengan volume terbesar HARI INI (default 40)
  --symbols A,B  pakai daftar koin sendiri (mis. BTC,ETH,SOL), mengabaikan --top
  --days N       panjang riwayat harian yang diunduh (default 1500)
  --warmup N     hari awal yang dilewati agar tren weekly aktif seperti di live (default 400)
  --hold N       masa berlaku order limit dalam hari (default 7, sama dengan jurnal)
  --maxsl P      batas jarak SL dalam persen (default 15, sama dengan jurnal)
  --fee P        biaya per sisi, persen (default 0.05)   --slip P  slippage keluar, persen (default 0.05)
  --no-dedupe    catat sinyal tiap hari seperti jurnal live (default: satu order aktif per koin)
  --precise      resolusi 1 menit untuk candle 1H yang ambigu (lebih akurat, lebih banyak request)
  --boot N       jumlah resample bootstrap (default 5000)   --seed N  seed acak (default 1)
  --entry MODE   limit (default, order di level engine) atau market (masuk di open hari sinyal)
  --tp-mult X    ganti TP engine dengan kelipatan risiko tetap (mis. 2); default pakai TP engine
  --split TGL    pisahkan hasil jadi pengembangan (sebelum TGL) dan UJI TERKUNCI (sejak TGL), format YYYY-MM-DD
  --refresh      hapus cache dan unduh ulang
  --out DIR      folder keluaran (default backtest/out)    --cache DIR  folder cache (default backtest/cache)`;

export function parseArgs(a) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < a.length; i++) {
    const x = a[i], nx = () => a[++i];
    if (x === '--top') o.top = +nx();
    else if (x === '--days') o.days = +nx();
    else if (x === '--warmup') o.warmup = +nx();
    else if (x === '--hold') o.hold = +nx();
    else if (x === '--maxsl') o.maxsl = +nx();
    else if (x === '--fee') o.fee = +nx();
    else if (x === '--slip') o.slip = +nx();
    else if (x === '--boot') o.boot = +nx();
    else if (x === '--seed') o.seed = +nx();
    else if (x === '--conc') o.conc = +nx();
    else if (x === '--out') o.out = nx();
    else if (x === '--cache') o.cache = nx();
    else if (x === '--symbols') o.symbols = nx().split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (x === '--entry') { o.entry = nx(); if (!['limit', 'market'].includes(o.entry)) throw new Error('--entry harus limit atau market'); }
    else if (x === '--tp-mult') o.tpMult = +nx();
    else if (x === '--split') { o.split = nx(); if (!(Date.parse(o.split) > 0)) throw new Error('--split harus YYYY-MM-DD'); }
    else if (x === '--no-dedupe') o.dedupe = false;
    else if (x === '--precise') o.precise = true;
    else if (x === '--refresh') o.refresh = true;
    else if (x === '--help' || x === '-h') { console.log(HELP); process.exit(0); }
    else throw new Error('opsi tidak dikenal: ' + x + '\n' + HELP);
  }
  return o;
}

// ---------- data ----------
async function fetchDaily(sym, from) {
  const out = []; let s = from;
  for (;;) {
    const a = await retry(() => bj(`klines?symbol=${sym}USDT&interval=1d&startTime=${s}&limit=1000`));
    if (!a.length) break;
    for (const x of a) out.push({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] });
    if (a.length < 1000) break;
    s = a.at(-1)[0] + DAY;
  }
  return out;
}
async function loadDaily(sym, o) {
  const f = path.join(o.cache, `d1-${sym}.json`), now = Date.now(), need = now - o.days * DAY;
  let k = [];
  if (!o.refresh && fs.existsSync(f)) { try { k = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { k = []; } }
  if (k.length && k[0].t > need + DAY && k.length < o.days - 5) k = []; // cache lebih pendek dari yang diminta
  const from = k.length ? k.at(-1).t + DAY : need;
  const add = (await fetchDaily(sym, from)).filter(c => c.t + DAY <= now); // hanya candle yang sudah tutup
  const m = new Map(k.map(c => [c.t, c])); for (const c of add) m.set(c.t, c);
  k = [...m.values()].sort((a, b) => a.t - b.t).filter(c => c.t >= need - DAY);
  fs.writeFileSync(f, JSON.stringify(k));
  return k;
}
export const win = (k, i) => [...k.slice(Math.max(0, i - 999), i), { t: k[i].t, o: k[i].o, h: k[i].o, l: k[i].o, c: k[i].o, v: 0 }];

// ---------- inti ----------
export async function runBacktest(o, log = () => {}) {
  fs.mkdirSync(o.cache, { recursive: true });
  const now = Date.now(), cost = 2 * o.fee + o.slip; // biaya bulat-penuh, persen dari entry
  let syms = o.symbols;
  if (!syms || !syms.length) {
    const t = await retry(() => bj('ticker/24hr'));
    syms = t.filter(x => x.symbol.endsWith('USDT') && !NOT.test(x.symbol.slice(0, -4)))
      .sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, o.top).map(x => x.symbol.slice(0, -4));
  }
  // cache candle 1H per sinyal
  const hf = path.join(o.cache, 'h1.json');
  const H1C = !o.refresh && fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, 'utf8')) : {};
  const nH = (o.fetchHold || o.hold) * 24 + 2;
  const fetchH1 = async (sym, t) => {
    const key = `${sym}:${t}:${nH}`;
    if (!H1C[key]) {
      const rows = await retry(() => bj(`klines?symbol=${sym}USDT&interval=1h&startTime=${t}&limit=${nH}`));
      H1C[key] = rows.map(a => [a[0], a[1], a[2], a[3], a[4], 0, a[6]]);
    }
    return H1C[key].map(mapK);
  };
  const m1f = sym => (a, b) => retry(() => bj(`klines?symbol=${sym}USDT&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).then(x => x.map(mapK));

  // konteks BTC per hari (tren) untuk menandai sinyal altcoin
  const btcK = await loadDaily('BTC', o), ctx = new Map();
  for (let i = o.warmup; i < btcK.length; i++) { try { ctx.set(btcK[i].t, feat(win(btcK, i), 0).tr); } catch { /* data kurang */ } }

  const meta = { universe: syms.length, used: 0, skipped: [], immature: 0 };
  const per = await pool(syms, o.conc, async sym => {
    const k = sym === 'BTC' ? btcK : await loadDaily(sym, o);
    if (k.length < o.warmup + 30) { meta.skipped.push(`${sym} (riwayat ${k.length} hari)`); return []; }
    meta.used++;
    const out = []; let busy = 0;
    for (let i = o.warmup; i < k.length; i++) {
      const day = k[i];
      if (day.t < busy) continue;
      if (day.t + o.hold * DAY > now) { meta.immature++; break; } // belum cukup waktu untuk dinilai
      let f; try { f = feat(win(k, i), k[i - 1].v * k[i - 1].c); } catch { continue; }
      if (!f.side || !(f.slp <= o.maxsl) || f.type === 'ditolak') continue;
      const s = f.side, due = day.t + o.hold * DAY;
      const E = o.entry === 'market' ? f.px : f.entry, risk = Math.abs(E - f.sl);
      const T = o.tpMult ? E + s * o.tpMult * risk : f.tp;
      if (![E, f.sl, T].every(Number.isFinite) || !(s * (E - f.sl) > 0) || !(s * (T - E) > 0) || (risk / E) * 100 > o.maxsl) continue;
      const src = { h1: () => fetchH1(sym, day.t), m1: o.precise ? m1f(sym) : undefined, now };
      const g = await gradeTrade({ arah: s == 1 ? 'LONG' : 'SHORT', entry: E, sl: f.sl, tp: T, t: day.t, due }, src);
      if (!g) continue;
      const net = (gr, hasil, slp) => (FILLED(hasil) ? gr - cost / slp : 0);
      const slp = (risk / E) * 100, px = f.px, slpB = (risk / px) * 100, bm = o.tpMult || 2;
      // baseline: market di open hari sinyal, jarak risiko sama
      const base = async (dir, tag) => {
        const sd = dir * s;
        const b = await gradeTrade({ arah: sd == 1 ? 'LONG' : 'SHORT', entry: px, sl: px - sd * risk, tp: px + sd * bm * risk, t: day.t, due }, src);
        return { [tag + 'Hasil']: b.hasil, [tag + 'R']: net(b.R, b.hasil, slpB), [tag + 'Exit']: b.t };
      };
      out.push({
        sym, date: iso(day.t), t: day.t, s, side: s == 1 ? 'LONG' : 'SHORT', trig: f.trig, tr: f.tr, btcTr: sym === 'BTC' ? null : ctx.get(day.t) ?? 0,
        type: f.type, slp: +slp.toFixed(2), pos: +f.pos.toFixed(2), why: f.why.join('|').replace(/,/g, ';'),
        entry: E, sl: f.sl, tp: T, hasil: g.hasil, Rg: g.R, R: net(g.R, g.hasil, slp), exitT: g.t,
        ...(await base(-1, 'mir')), ...(await base(1, 'mkt')),
      });
      if (o.dedupe) busy = g.t;
    }
    log(`${sym}: ${out.length} sinyal`);
    return out;
  });
  fs.writeFileSync(hf, JSON.stringify(H1C));
  return { trades: per.flat().sort((a, b) => a.t - b.t), meta };
}

// ---------- laporan ----------
const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '-');
const rr = x => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : '-');
const ci = c => (c ? `[${rr(c.lo)}, ${rr(c.hi)}]` : 'n/a');
const verdict = (n, c) => (n < 30 ? 'n<30, abaikan' : !c ? 'n/a' : c.lo > 0 ? 'CI di atas 0' : c.hi < 0 ? 'CI di bawah 0' : 'tidak signifikan');

function groupTable(title, rows, keyFn, o) {
  const g = [...groupBy(rows, keyFn)].map(([k, v]) => [k, v, summarize(v)]).sort((a, b) => b[2].filled - a[2].filled);
  const G = Math.max(1, g.filter(x => x[2].filled >= 30).length), alpha = 0.05 / G;
  let md = `\n### ${title}\n(hanya trade terisi; CI dikoreksi Bonferroni untuk ${G} grup: tingkat ${((1 - alpha) * 100).toFixed(1)}%)\n\n| Grup | Terisi | Win% | Rata-rata R | CI | Status |\n|---|---|---|---|---|---|\n`;
  const js = {};
  for (const [k, v, s] of g) {
    const c = s.filled >= 30 ? bootCI(v, { B: o.boot, seed: o.seed, alpha }) : null;
    md += `| ${k} | ${s.filled} | ${pct(s.win)} | ${rr(s.mean)} | ${ci(c)} | ${verdict(s.filled, c)} |\n`;
    js[k] = { ...s, ci: c };
  }
  return { md, js };
}

export function buildReport(trades, o, meta) {
  if (!trades.length) return { md: '# Backtest\n\nTidak ada sinyal. Periksa data atau parameter.\n', summary: { n: 0 } };
  const S = summarize(trades), C = bootCI(trades, { B: o.boot, seed: o.seed });
  const asRows = (h, r, e) => trades.map(x => ({ hasil: x[h], R: x[r], exitT: x[e], t: x.t }));
  const mir = asRows('mirHasil', 'mirR', 'mirExit'), mkt = asRows('mktHasil', 'mktR', 'mktExit');
  const Sm = summarize(mir), Cm = bootCI(mir, { B: o.boot, seed: o.seed }), Sk = summarize(mkt), Ck = bootCI(mkt, { B: o.boot, seed: o.seed });
  // Perbandingan dengan baseline HARUS per sinyal: order limit yang tidak terisi sering justru yang berlari
  // menjauh (adverse selection). Membuangnya akan membuat strategi tampak lebih baik dari yang sebenarnya.
  const Cs = bootCI(trades, { B: o.boot, seed: o.seed, all: true });
  const dM = bootCI(trades.map(x => ({ hasil: 'TP', R: x.R - x.mirR, t: x.t })), { B: o.boot, seed: o.seed });
  const dK = bootCI(trades.map(x => ({ hasil: 'TP', R: x.R - x.mktR, t: x.t })), { B: o.boot, seed: o.seed });
  const row = (n, s, c) => `| ${n} | ${s.signals} | ${s.filled} (${pct(s.fillRate)}) | ${s.tp}/${s.sl}/${s.exp} | ${pct(s.win)} | ${rr(s.mean)} | ${ci(c)} | ${rr(s.perSignal)} | ${rr(s.median)} | ${rr(s.total)} | ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : '-'} | ${s.maxDD.toFixed(1)} |`;
  let md = `# Backtest CryptoEliz\n\n`;
  md += `- Periode sinyal: ${trades[0].date} sampai ${trades.at(-1).date} | koin dipakai: ${meta.used} dari ${meta.universe}${meta.skipped.length ? ` (dilewati: ${meta.skipped.join(', ')})` : ''}\n`;
  md += `- Parameter: hold ${o.hold} hari, SL maks ${o.maxsl}%, biaya ${o.fee}%/sisi + slip ${o.slip}% (total ${(2 * o.fee + o.slip).toFixed(2)}% per trade), ${o.dedupe ? 'satu order aktif per koin' : 'semua sinyal harian dicatat (tumpang tindih)'}, resolusi ${o.precise ? '1 menit untuk candle ambigu' : '1H, SL didahulukan bila ambigu'}\n`;
  md += `- Blok bootstrap: ${C ? C.clusters : 0} minggu berbeda. Jumlah minggu inilah ukuran sampel independen yang sebenarnya, bukan jumlah trade.\n\n`;
  md += `## Ringkasan (R = kelipatan risiko, sudah dikurangi biaya)\n\nR/trade = rata-rata per trade yang terisi (yang benar-benar kamu alami). R/sinyal = total R dibagi SEMUA sinyal, tidak terisi dihitung 0R (dasar perbandingan dengan baseline).\n\n| Skenario | Sinyal | Terisi | TP/SL/Exp | Win% | R/trade | CI 95% R/trade | R/sinyal | Median R | Total R | PF | MaxDD (R) |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  md += row('**Strategi (limit di level)**', S, C) + '\n' + row('Baseline MIRROR (arah dibalik)', Sm, Cm) + '\n' + row('Baseline MARKET (arah sama, entry open)', Sk, Ck) + '\n';
  md += `\nCI 95% untuk strategi per SINYAL (tidak terisi = 0R): ${ci(Cs)}\n`;
  md += `\nSelisih berpasangan PER SINYAL, strategi dikurangi baseline:\n- vs MIRROR: CI 95% ${ci(dM)}${dM ? ` (P selisih<=0: ${(dM.pLE0 * 100).toFixed(1)}%)` : ''}\n- vs MARKET: CI 95% ${ci(dK)}${dK ? ` (P selisih<=0: ${(dK.pLE0 * 100).toFixed(1)}%)` : ''}\n`;
  const adv = Sk.perSignal - S.perSignal;
  md += `\n**Kesimpulan otomatis:** ${C && C.lo > 0 ? 'R/trade strategi positif secara statistik (CI 95% di atas 0)' : 'edge positif BELUM terbukti (CI R/trade mencakup atau di bawah 0)'}; ` +
    `${dM && dM.lo > 0 ? 'lebih baik dari MIRROR' : 'belum terbukti lebih baik dari MIRROR'}; ${dK && dK.lo > 0 ? 'lebih baik dari MARKET per sinyal (logika limit di level menambah nilai)' : dK && dK.hi < 0 ? 'LEBIH BURUK dari MARKET per sinyal (menunggu retest merugikan: sinyal yang tidak terisi justru lebih baik)' : 'belum terbukti lebih baik dari MARKET per sinyal'}.\n`;
  if (Number.isFinite(adv) && adv > 0.05) md += `\nPeringatan adverse selection: entry market di open rata-rata ${rr(Sk.perSignal)}R/sinyal, strategi limit ${rr(S.perSignal)}R/sinyal. Order limit yang terisi cenderung yang bergerak melawanmu, sedangkan yang berlari menjauh tidak terisi.\n`;
  if (o.split) {
    const T0 = Date.parse(o.split), part = (name, rows) => {
      const s2 = summarize(rows), c2 = bootCI(rows, { B: o.boot, seed: o.seed }), d2 = bootCI(rows.map(x => ({ hasil: 'TP', R: x.R - x.mktR, t: x.t })), { B: o.boot, seed: o.seed });
      return `| ${name} | ${s2.signals} | ${s2.filled} | ${pct(s2.win)} | ${rr(s2.mean)} | ${ci(c2)} | ${rr(s2.perSignal)} | ${ci(d2)} |`;
    };
    md += `\n## Pembagian waktu: pengembangan vs uji terkunci\n\n| Periode | Sinyal | Terisi | Win% | R/trade | CI 95% R/trade | R/sinyal | CI selisih vs MARKET (per sinyal) |\n|---|---|---|---|---|---|---|---|\n`;
    md += part(`Pengembangan (sebelum ${o.split})`, trades.filter(x => x.t < T0)) + '\n' + part(`UJI TERKUNCI (sejak ${o.split})`, trades.filter(x => x.t >= T0)) + '\n';
    md += `\nPeriode terkunci hanya bermakna bila aturan TIDAK diubah setelah melihat angkanya.\n`;
  }
  const tables = [
    groupTable('Per pemicu (trigger)', trades, x => x.trig, o),
    groupTable('Per arah', trades, x => x.side, o),
    groupTable('Searah / lawan tren makro koin', trades, x => (x.tr === x.s ? 'searah tren' : x.tr === 0 ? 'tren netral' : 'lawan tren'), o),
    groupTable('Terhadap tren BTC', trades, x => (x.btcTr == null ? 'BTC sendiri' : x.btcTr === 0 ? 'BTC netral' : x.btcTr === x.s ? 'searah BTC' : 'lawan BTC'), o),
    groupTable('Tipe setup', trades, x => x.type, o),
    groupTable('Per kuartal (stabilitas dari waktu ke waktu)', trades, x => `${x.date.slice(0, 4)}-Q${Math.floor(+x.date.slice(5, 7) / 3.01) + 1}`, o),
  ];
  md += tables.map(t => t.md).join('');
  md += `\n## Cara membaca dan batasannya\n- Win rate tidak bermakna sendirian. Yang menentukan adalah rata-rata R dan selang kepercayaannya.\n- Banyak grup diuji sekaligus, jadi sebagian akan tampak signifikan hanya karena kebetulan. Koreksi Bonferroni berlaku per tabel, bukan global; dengan 6 tabel, satu-dua tanda 'signifikan' tetap bisa muncul murni kebetulan (pada uji data acak tanpa edge pun kadang ada satu). Perlakukan grup yang positif sebagai hipotesis untuk diuji pada data baru, bukan bukti.\n- Universe diambil dari koin bervolume terbesar HARI INI, sehingga ada survivorship bias: koin yang gagal atau didelist tidak ikut teruji.\n- Scan disimulasikan tepat 00:00 UTC (hanya harga open hari itu), sedangkan jurnal live memindai jam 01-05 UTC. Hasilnya bisa sedikit berbeda.\n- Aturan engine dirancang setelah melihat chart terbaru, jadi periode terakhir bukan data out-of-sample murni. Pegang kuartal-kuartal paling lama sebagai uji yang lebih jujur.\n- Biaya funding futures, likuiditas, dan slippage nyata saat volatil belum dimodelkan. Ukuran posisi dianggap sama (1R per trade); drawdown dalam R bukan drawdown akun.\n`;
  return { md, summary: { params: o, meta, overall: { ...S, ci: C }, mirror: { ...Sm, ci: Cm }, market: { ...Sk, ci: Ck }, perSignalCI: Cs, diffVsMirror: dM, diffVsMarket: dK, groups: Object.fromEntries(tables.map((t, i) => [i, t.js])) } };
}

export function writeOutputs(trades, rep, o) {
  fs.mkdirSync(o.out, { recursive: true });
  const cols = ['sym', 'date', 'side', 'trig', 'tr', 'btcTr', 'type', 'slp', 'pos', 'entry', 'sl', 'tp', 'hasil', 'Rg', 'R', 'mirHasil', 'mirR', 'mktHasil', 'mktR', 'why'];
  const csv = [cols.join(','), ...trades.map(x => cols.map(c => (typeof x[c] === 'number' ? +x[c].toPrecision(6) : x[c] ?? '')).join(','))].join('\n');
  fs.writeFileSync(path.join(o.out, 'trades.csv'), csv);
  let c = 0; const eq = ['date,cumR,cumR_mirror,cumR_market'];
  let cm = 0, ck = 0;
  const f = trades.filter(x => FILLED(x.hasil)).sort((a, b) => a.exitT - b.exitT);
  for (const x of f) { c += x.R; cm += x.mirR; ck += x.mktR; eq.push(`${iso(x.exitT)},${c.toFixed(3)},${cm.toFixed(3)},${ck.toFixed(3)}`); }
  fs.writeFileSync(path.join(o.out, 'equity.csv'), eq.join('\n'));
  fs.writeFileSync(path.join(o.out, 'summary.json'), JSON.stringify(rep.summary, null, 1));
  fs.writeFileSync(path.join(o.out, 'report.md'), rep.md);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const o = parseArgs(process.argv.slice(2));
  console.error(`Backtest dimulai (top ${o.symbols ? o.symbols.length + ' koin' : o.top}, ${o.days} hari). Pertama kali bisa beberapa menit; berikutnya memakai cache.`);
  const { trades, meta } = await runBacktest(o, m => console.error(' ', m));
  const rep = buildReport(trades, o, meta);
  writeOutputs(trades, rep, o);
  console.log(rep.md);
  console.error(`\nTersimpan di ${o.out}/ : report.md, trades.csv, equity.csv, summary.json`);
}
