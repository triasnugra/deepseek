// Aturan penilaian trade yang SAMA dipakai jurnal live dan backtester.
//
// Opsi baru (backward-compatible; default = perilaku lama):
//   trail        : bool. Setelah MFE >= 1R, SL pindah ke entry (breakeven).
//                  Setelah MFE >= 2R, SL mengunci (MFE - 1R). Berlaku per candle 1H.
//   timeExitDays : integer|null. Jika trade masih terbuka setelah N hari, exit di close.
//
// Aturan lama (tetap):
//  1. Order limit terisi bila harga menyentuh entry. Candle dibuka di sisi entry yang
//     menguntungkan -> terisi di open.
//  2. Candle pengisi BOLEH menyentuh SL. TP di candle pengisi hanya dihitung bila
//     order terisi tepat di open.
//  3. SL & TP sama-sama kena di 1H: bila ada m1, urutan dari m1; jika tidak, SL dulu.
//  4. Candle yang memuat waktu sinyal tidak dipakai utuh (hanya lewat m1 setelah r.t).
//  5. Habis waktu: tidak terisi -> 0R; terisi -> dinilai di close candle terakhir.
export const H1 = 36e5;
export const mapK = a => ({ ot: a[0], o: +a[1], h: +a[2], l: +a[3], c: +a[4], ct: a[6] });

const rules = r => {
  const s = r.arah === 'LONG' ? 1 : -1;
  return {
    s,
    touch: k => (s == 1 ? k.l <= r.entry : k.h >= r.entry),
    open: k => (s == 1 ? k.o <= r.entry : k.o >= r.entry),
    sl: k => (s == 1 ? k.l <= r.sl : k.h >= r.sl),
    tp: k => (s == 1 ? k.h >= r.tp : k.l <= r.tp),
  };
};

// ---- walk klasik (tanpa trail): perilaku lama ----
function walk(cs, P, st) {
  for (const k of cs) {
    if (!st.fill) {
      const ao = P.open(k);
      if (!ao && !P.touch(k)) continue;
      st.fill = true;
      if (P.sl(k)) return { res: 'SL', t: k.ot };
      if (ao && P.tp(k)) return { res: 'TP', t: k.ot };
      continue;
    }
    if (P.sl(k)) return { res: 'SL', t: k.ot };
    if (P.tp(k)) return { res: 'TP', t: k.ot };
  }
  return null;
}

// ---- walk dengan trailing stop ----
function walkTrail(cs, P, st, entry, risk) {
  let sl = P.s == 1 ? P.slOf : P.slOf; // placeholder, diisi lewat st.slCur
  for (const k of cs) {
    if (!st.fill) {
      const ao = P.open(k);
      if (!ao && !P.touch(k)) continue;
      st.fill = true;
      st.slCur = P.slOf;
      if (P.sl(k)) return { res: 'SL', t: k.ot, sl: st.slCur };
      if (ao && P.tp(k)) return { res: 'TP', t: k.ot };
      continue;
    }
    // update trailing berdasarkan high/low candle ini
    const mfe = P.s == 1 ? k.h - entry : entry - k.l;
    if (mfe >= 2 * risk) st.slCur = P.s == 1 ? Math.max(st.slCur, entry + risk) : Math.min(st.slCur, entry - risk);
    else if (mfe >= 1 * risk) st.slCur = P.s == 1 ? Math.max(st.slCur, entry) : Math.min(st.slCur, entry);
    const slHit = P.s == 1 ? k.l <= st.slCur : k.h >= st.slCur;
    const tpHit = P.s == 1 ? k.h >= P.tpOf : k.l <= P.tpOf;
    if (slHit && tpHit) return { res: 'SL', t: k.ot, sl: st.slCur }; // konservatif
    if (slHit) return { res: 'SL', t: k.ot, sl: st.slCur };
    if (tpHit) return { res: 'TP', t: k.ot };
  }
  return null;
}

export async function gradeTrade(r, { h1, m1, now = Date.now(), trail = false, timeExitDays = null }) {
  const P = rules(r), risk = Math.abs(r.entry - r.sl), st = { fill: false, slCur: r.sl };
  if (!(risk > 0)) return { hasil: 'tidak valid', R: 0, t: r.t };
  // nilai SL efektif: untuk trailing, R dihitung terhadap SL yang benar-benar kena
  const done = (w) => {
    if (w.res === 'SL') {
      const realSl = w.sl != null ? w.sl : r.sl;
      return { hasil: 'SL', R: (P.s * (realSl - r.entry)) / risk, t: w.t, slExit: realSl };
    }
    return { hasil: 'TP', R: (P.s * (r.tp - r.entry)) / risk, t: w.t };
  };
  const cs = (await h1()).filter(k => k.ct < now);
  const walkFn = trail
    ? (cs, p, st) => walkTrail(cs, { ...p, slOf: p.sl, tpOf: p.tp }, st, r.entry, risk)
    : walk;

  if (cs.length && cs[0].ot < r.t) {
    const k0 = cs.shift();
    if (m1) {
      const ms = (await m1(Math.max(k0.ot, r.t), k0.ct)).filter(m => m.ot >= r.t);
      const w = walkFn(ms, P, st);
      if (w) return done(w);
    }
  }

  let last = null;
  const timeDue = timeExitDays ? Math.min(r.due, r.t + timeExitDays * 24 * H1) : r.due;
  for (const k of cs) {
    if (k.ct > timeDue) break;
    last = k;
    const amb = st.fill ? P.sl(k) && P.tp(k) : (P.touch(k) || P.open(k)) && (P.sl(k) || P.tp(k));
    const w = amb && m1 ? walkFn(await m1(k.ot, k.ct), P, st) : walkFn([k], P, st);
    if (w) return done(w);
  }

  if (now < timeDue) return null;
  if (!st.fill) return { hasil: 'tidak terisi', R: 0, t: timeDue };
  return { hasil: 'kedaluwarsa', R: (P.s * ((last ? last.c : r.entry) - r.entry)) / risk, t: timeDue };
}
