/* PayCostBattle ゲームエンジン（DOMに依存しない純粋なロジック）
 *
 * ルール本体は docs/rules.md。web/index.html（単一ファイル版）と同じルールを、
 * 演出付きのサイドビュー版（web/battle.html）から使えるように切り出したもの。
 *
 *   const cfg = PCB.makeConfig();               // 既定値（必要なら上書き）
 *   const S   = PCB.newState(cfg);
 *   const r   = PCB.resolve(S, ['A','D'], Math.random, cfg);   // 1ラウンドを処理（状態は変えない）
 *   PCB.apply(S, ['A','D'], r);                 // 結果を状態に反映
 *   PCB.cpuChoose(S, 1, 'normal', cfg);         // CPUの手
 *
 * コマンド：'A'=攻撃、'C'=溜める、'D'=防御
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    hp: 100,            // 初期HP・上限
    attackCost: 5,      // 攻撃のコスト
    damage: 10,         // 攻撃ダメージ
    heal: 5,            // 溜めるの回復量
    chargeMult: 2,      // 溜め後の攻撃倍率
    drain: 5,           // クリティカルのドレイン量
    mirror: 2,          // あいこ（同じ手）のペナルティ
    critBase: 0.10,     // クリティカル基本率
    critK: 0.008,       // HP差1あたりの上昇
    critCap: 0.50,      // 上限
    defStep: 0.25,      // 防御の成功率の低下幅（連続1回あたり）
    noDefAfterCharge: 0, // 1なら、溜めた次は防御不可（既定は可）
    // ---- 2026-10-16 テスト導入 ----
    justGuard: 1,       // 1ならジャストガードあり（防御版クリティカル）
    jgBase: 0.10,       // ジャストガード基本率（クリティカルと同じ式：自分のHPが相手より低いほど上がる）
    jgK: 0.008,
    jgCap: 0.50,
    jgStep: 0,          // 連続で防御に成功した回数1回あたり、ジャストガード率に足す分（0＝足さない）
    reflect: 5,        // ジャストガード時、攻撃側に返す反射ダメージ
    lowChargeRatio: 0.10 // 自分のHPがこの割合（上限比）未満なら、防御の次でも「溜め」を選べる
  };

  function makeConfig(patch) { return Object.assign({}, DEFAULTS, patch || {}); }

  // hp＝自分の現在HP（省略可）。防御の次は溜める不可だが、HPが上限の lowChargeRatio 未満なら溜められる
  function allowed(last, cfg, hp) {
    cfg = cfg || DEFAULTS;
    if (last === null || last === 'A') return ['A', 'C', 'D'];
    if (last === 'C') return cfg.noDefAfterCharge ? ['A', 'C'] : ['A', 'C', 'D'];
    if (hp != null && hp < cfg.hp * cfg.lowChargeRatio) return ['A', 'C', 'D'];
    return ['A', 'D'];
  }

  // ds＝直前までの連続防御回数。1回目100%、以後 defStep ずつ低下（0未満にはならない）
  function succRate(ds, cfg) { return Math.max(0, 1 - cfg.defStep * ds); }

  // 自分(i)のクリティカル率。自分のHPが相手より低いほど上がる
  function critRate(hp, i, cfg) {
    return Math.min(cfg.critCap, cfg.critBase + Math.max(0, hp[1 - i] - hp[i]) * cfg.critK);
  }

  // 自分(i)のジャストガード率（防御成功時に判定）。自分のHPが相手より低いほど上がる
  function jgRate(hp, i, cfg, ds) {
    if (!cfg.justGuard) return 0;
    return Math.min(cfg.jgCap, cfg.jgBase + Math.max(0, hp[1 - i] - hp[i]) * cfg.jgK + (cfg.jgStep || 0) * (ds || 0));
  }

  function newState(cfg) {
    return {
      hp: [cfg.hp, cfg.hp], last: [null, null], ch: [false, false], ds: [0, 0],
      round: 1, hist: [[], []], over: false, result: null
    };
  }

  /**
   * 1ラウンドを処理する（同時処理）。状態Sは変更しない。
   * 返り値：{ hp, ch, ds, last, delta, events }
   *   events：演出用の出来事の配列（処理順）
   *     {t:'attack', from, to, cost, dmg, mult, defended, blocked, defFailed, succ, crit:{hit,rate,amount}}
   *     {t:'charge', who, gain, loaded, atCap}
   *     {t:'guardIdle', who}                （防御したが攻撃が来なかった）
   *     {t:'mirror', amount}
   */
  function resolve(S, cmd, rnd, cfg) {
    const events = [], delta = [0, 0], loaded = [false, false], failed = [false, false];
    for (let i = 0; i < 2; i++) {
      const j = 1 - i;
      if (cmd[i] === 'A') {
        delta[i] -= cfg.attackCost;
        const mult = S.ch[i] ? cfg.chargeMult : 1;
        const dmg = cfg.damage * mult;
        const ev = { t: 'attack', from: i, to: j, cost: cfg.attackCost, dmg, mult,
                     defended: cmd[j] === 'D', blocked: false, defFailed: false, succ: null,
                     just: { hit: false, rate: 0, reflect: 0 },
                     crit: { hit: false, rate: 0, amount: 0, reflected: false } };
        if (cmd[j] !== 'D') {
          delta[j] -= dmg;
        } else {
          const sr = succRate(S.ds[j], cfg);
          ev.succ = sr;
          if (rnd() < sr) {
            ev.blocked = true;
            const jr = jgRate(S.hp, j, cfg, S.ds[j]);
            ev.just.rate = jr;
            if (jr > 0 && rnd() < jr) { ev.just.hit = true; ev.just.reflect = cfg.reflect; delta[i] -= cfg.reflect; }
          } else { delta[j] -= dmg; ev.defFailed = true; failed[j] = true; }
        }
        const rate = critRate(S.hp, i, cfg);
        ev.crit.rate = rate;
        if (rnd() < rate) {
          const dr = cfg.drain * (cmd[j] === 'C' ? 2 : 1);
          ev.crit.hit = true; ev.crit.amount = dr;
          if (ev.just.hit) { delta[i] -= dr; ev.crit.reflected = true; }   // ジャストガード：本来受けるクリティカルの分を、攻撃側が受ける（ドレインは起きない）
          else { delta[j] -= dr; delta[i] += dr; }
        }
        events.push(ev);
      } else if (cmd[i] === 'C') {
        const atCap = S.hp[i] >= cfg.hp;
        delta[i] += cfg.heal;
        if (!atCap) loaded[i] = true;
        events.push({ t: 'charge', who: i, gain: cfg.heal, loaded: !atCap, atCap });
      } else if (cmd[j] !== 'A') {
        events.push({ t: 'guardIdle', who: i });
      }
    }
    if (cmd[0] === cmd[1] && cfg.mirror) {
      delta[0] -= cfg.mirror; delta[1] -= cfg.mirror;
      events.push({ t: 'mirror', amount: cfg.mirror });
    }
    const hp = [0, 1].map(i => Math.min(cfg.hp, S.hp[i] + delta[i]));
    const ch = [0, 1].map(i => cmd[i] === 'C' ? loaded[i] : false);
    const ds = [0, 1].map(i => cmd[i] === 'D' ? (failed[i] ? 0 : S.ds[i] + 1) : 0);
    return { hp, ch, ds, last: cmd.slice(), delta, events };
  }

  // 処理結果を状態に反映する
  function apply(S, cmd, r) {
    S.hp = r.hp; S.ch = r.ch; S.ds = r.ds; S.last = r.last;
    S.hist[0].push(cmd[0]); S.hist[1].push(cmd[1]);
    S.round += 1;
    const d0 = S.hp[0] <= 0, d1 = S.hp[1] <= 0;
    if (d0 || d1) { S.over = true; S.result = d0 && d1 ? 'draw' : (d0 ? 1 : 0); }
    return S;
  }

  function weighted(w, ok, rnd) {
    const ent = ok.map(c => [c, Math.max(0.0001, w[c] || 0.0001)]);
    const tot = ent.reduce((a, e) => a + e[1], 0);
    let x = rnd() * tot;
    for (const e of ent) { x -= e[1]; if (x <= 0) return e[0]; }
    return ent[ent.length - 1][0];
  }

  // 相手(j)の次の手の予測。全体の頻度と「直前の手が同じだった時の次の手」を、観測数に応じて混ぜる
  function oppModel(S, j, cfg) {
    const h = S.hist[j], last = S.last[j];
    const glob = { A: 1, C: 1, D: 1 }, cond = { A: 0.3, C: 0.3, D: 0.3 };
    let n = 0;
    h.forEach((c, k) => {
      glob[c] += k >= h.length - 6 ? 2 : 1;
      if (k > 0 && h[k - 1] === last) { cond[c] += 1.5; n++; }
    });
    const oppOk = allowed(last, cfg, S.hp[j]);
    const gT = oppOk.reduce((a, c) => a + glob[c], 0), cT = oppOk.reduce((a, c) => a + cond[c], 0);
    const wc = Math.min(0.8, n / (n + 2));
    const p = {};
    oppOk.forEach(c => { p[c] = (1 - wc) * glob[c] / gT + wc * cond[c] / cT; });
    return { oppOk, p, n };
  }

  // ---------- 最強：均衡（ナッシュ）の勝率表を使って、1手先を読み、混ぜ方（確率）まで最適に近づける ----------
  // 勝率表 tbl＝{ H, data(Uint8Array) }。tools/sim/make-eq-table.mjs が作る（P1の勝率×255。溜め済みの有無まで）
  let EQ = null;
  function setEqTable(tbl) { EQ = tbl || null; }
  function eqValue(h0, h1, c0, c1) {           // P(0側が勝つ)
    if (h0 <= 0 && h1 <= 0) return 0.5;
    if (h0 <= 0) return 0;
    if (h1 <= 0) return 1;
    const H = EQ.H;
    return EQ.data[((Math.min(H, h0) * (H + 1) + Math.min(H, h1)) * 2 + c0) * 2 + c1] / 255;
  }
  // 手の組 cmd の結果を、確率つきで全部数え上げる（resolve と同じ規則。乱数は使わない）
  function enumerate(S, cmd, cfg) {
    const delta = [0, 0], loaded = [false, false], att = [];
    for (let i = 0; i < 2; i++) {
      const j = 1 - i;
      if (cmd[i] === 'A') {
        delta[i] -= cfg.attackCost;
        const dmg = cfg.damage * (S.ch[i] ? cfg.chargeMult : 1);
        const defending = cmd[j] === 'D';
        att.push({ i, j, dmg, rate: critRate(S.hp, i, cfg), defending,
                   sr: defending ? succRate(S.ds[j], cfg) : 0, jr: defending ? jgRate(S.hp, j, cfg, S.ds[j]) : 0,
                   drain: cfg.drain * (cmd[j] === 'C' ? 2 : 1) });
      } else if (cmd[i] === 'C') { delta[i] += cfg.heal; loaded[i] = S.hp[i] < cfg.hp; }
    }
    let br = [{ p: 1, dl: delta.slice() }];
    for (const a of att) {
      const nb = [];
      for (const b of br) {
        const blk = a.defending ? [[1 - a.sr, 'fail'], [a.sr * (1 - a.jr), 'block'], [a.sr * a.jr, 'just']] : [[1, 'hit']];
        for (const [pb, kind] of blk) {
          if (pb <= 0) continue;
          const cr = a.rate > 0 ? [[a.rate, true], [1 - a.rate, false]] : [[1, false]];
          for (const [pc, crit] of cr) {
            if (pc <= 0) continue;
            const dl = b.dl.slice();
            if (kind === 'fail' || kind === 'hit') dl[a.j] -= a.dmg;
            if (kind === 'just') dl[a.i] -= cfg.reflect;
            if (crit) { if (kind === 'just') dl[a.i] -= a.drain; else { dl[a.j] -= a.drain; dl[a.i] += a.drain; } }
            nb.push({ p: b.p * pb * pc, dl });
          }
        }
      }
      br = nb;
    }
    return br.map((b) => {
      const dl = b.dl;
      if (cmd[0] === cmd[1] && cfg.mirror) { dl[0] -= cfg.mirror; dl[1] -= cfg.mirror; }
      return { p: b.p, hp: [Math.min(cfg.hp, S.hp[0] + dl[0]), Math.min(cfg.hp, S.hp[1] + dl[1])],
               ch: [0, 1].map((k) => (cmd[k] === 'C' && loaded[k]) ? 1 : 0) };
    });
  }
  // 小さな行列ゲームの最適な混ぜ方（行側が最大化）。サポート列挙で解く
  function gauss(M, b) {
    const n = b.length, a = M.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-12) return null;
      const t = a[c]; a[c] = a[piv]; a[piv] = t;
      for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
    }
    return a.map((r, i) => r[n] / r[i]);
  }
  function solveGame(A, nr, nc) {
    let bestV = -1, bestP = null;
    const cand = (p) => {
      let m = 1e9;
      for (let j = 0; j < nc; j++) { let sum = 0; for (let i = 0; i < nr; i++) sum += p[i] * A[i][j]; if (sum < m) m = sum; }
      if (m > bestV + 1e-12) { bestV = m; bestP = p.slice(); }
    };
    for (let i = 0; i < nr; i++) { const p = new Array(nr).fill(0); p[i] = 1; cand(p); }
    const sets = [[0, 1], [0, 2], [1, 2], [0, 1, 2]];
    for (const S of sets.filter((x) => x.every((y) => y < nr))) for (const T of sets.filter((x) => x.every((y) => y < nc))) {
      if (S.length !== T.length) continue;
      const k = S.length, M = [new Array(k).fill(1)], rhs = [1];
      for (let t = 1; t < k; t++) { M.push(S.map((i) => A[i][T[t]] - A[i][T[0]])); rhs.push(0); }
      const p = gauss(M, rhs);
      if (!p || p.some((x) => x < -1e-9)) continue;
      const full = new Array(nr).fill(0); S.forEach((i, n) => { full[i] = Math.max(0, p[n]); });
      cand(full);
    }
    return { v: bestV, p: bestP };
  }
  // 最強：勝率表で1手先を読んだ「手ごとの期待勝率」を、(1)相手の癖の予測と(2)相手が均衡で来た場合、の両方に対して求めて混ぜる。
  // EXPLOIT＝予測をどれだけ信じるか（0＝完全に均衡、1＝予測だけ）。選ぶ手は、混ぜた期待勝率が最大の手（同率なら均衡の混ぜ方）
  // 人間（ログ860ラウンド）の手の傾向：キー＝[相手が溜め済み][自分が溜め済み][相手の前の手 N=初手/A/C/D] → [攻撃, 溜め, 防御] の回数
  const HUMAN_PRIOR = {"00N":[0,21,1],"00C":[9,27,10],"00D":[146,15,56],"01A":[25,61,54],"01C":[0,1,0],"11C":[12,12,44],"01D":[15,2,60],"10C":[58,50,23],"00A":[44,64,50]};
  // 人間の傾向を、状況（相手・自分の溜め済み、相手の前の手）から引く。件数が少ない状況は、溜め済みだけの集計、全体の順にならして使う
  function humanProb(S, i, j, okOpp) {
    const key = (S.ch[j] ? '1' : '0') + (S.ch[i] ? '1' : '0');
    const tot = [0, 0, 0], loadSum = [0, 0, 0];
    for (const k in HUMAN_PRIOR) { for (let a = 0; a < 3; a++) { tot[a] += HUMAN_PRIOR[k][a]; if (k.slice(0, 2) === key) loadSum[a] += HUMAN_PRIOR[k][a]; } }
    const norm = (c, base, st) => { const n = c[0] + c[1] + c[2]; return c.map((x, a) => (x + st * base[a]) / (n + st)); };
    const g = norm(tot, [1 / 3, 1 / 3, 1 / 3], 3);
    const l = norm(loadSum, g, 8);
    const f = norm(HUMAN_PRIOR[key + (S.last[j] || 'N')] || [0, 0, 0], l, 8);
    const idx = { A: 0, C: 1, D: 2 };
    const ps = okOpp.map((c) => f[idx[c]]), z = ps.reduce((x, y) => x + y, 0) || 1;
    return ps.map((x) => x / z);
  }
  let EXPLOIT = 0.6, USE_PRIOR = true;
  function setExploit(x, usePrior) { EXPLOIT = x; if (usePrior !== undefined) USE_PRIOR = usePrior; }
  function cpuMax(S, i, cfg, rnd) {
    const j = 1 - i, ok = allowed(S.last[i], cfg, S.hp[i]), okOpp = allowed(S.last[j], cfg, S.hp[j]);
    const A = ok.map((a) => okOpp.map((b) => {
      const cmd = i === 0 ? [a, b] : [b, a];
      let v = 0;
      for (const o of enumerate(S, cmd, cfg)) v += o.p * eqValue(o.hp[0], o.hp[1], o.ch[0], o.ch[1]);
      return i === 0 ? v : 1 - v;      // CPU側の勝率
    }));
    const eq = solveGame(A, ok.length, okOpp.length);
    const Bt = okOpp.map((_, c) => ok.map((_, r) => 1 - A[r][c]));
    const q = solveGame(Bt, okOpp.length, ok.length).p;            // 相手の均衡の混ぜ方
    const model = oppModel(S, j, cfg);
    const pm0 = okOpp.map((c) => (model.p[c] || 0));
    const tot0 = pm0.reduce((x, y) => x + y, 0) || 1;
    // 予測＝人間の傾向（状況別）と、この対戦での癖を混ぜる。観測が少ないうちは、傾向を中心にする
    const hp = USE_PRIOR ? humanProb(S, i, j, okOpp) : null;
    const pm = hp ? okOpp.map((_, k) => 0.7 * hp[k] + 0.3 * pm0[k] / tot0) : pm0.map((x) => x / tot0);
    const w = hp ? EXPLOIT : EXPLOIT * Math.min(1, model.n / 4);   // 傾向が無い時は、観測が少ないうちは予測を信じすぎない
    const qq = okOpp.map((_, k) => w * pm[k] + (1 - w) * q[k]);
    const val = ok.map((_, r) => qq.reduce((acc, qk, k) => acc + qk * A[r][k], 0));
    let best = 0;
    for (let r = 1; r < ok.length; r++) if (val[r] > val[best] + 1e-9) best = r;
    // 均衡でも同じくらい良い手があるなら、均衡の混ぜ方で選ぶ（読まれにくくする）
    const near = ok.map((_, r) => val[r] >= val[best] - 0.004);
    const pe = eq.p.map((x, r) => near[r] ? x : 0), te = pe.reduce((x, y) => x + y, 0);
    if (te > 1e-9) { let x = rnd() * te, acc = 0; for (let r = 0; r < ok.length; r++) { acc += pe[r]; if (x < acc) return ok[r]; } }
    return ok[best];
  }

  /** CPUの手。相手の現在の手は見ない（履歴と盤面のみ）。diff＝'easy'|'normal'|'hard'|'max' */
  function cpuChoose(S, i, diff, cfg, rnd) {
    rnd = rnd || Math.random;
    const j = 1 - i, ok = allowed(S.last[i], cfg, S.hp[i]);
    if (diff === 'max' && EQ && EQ.H === cfg.hp) return cpuMax(S, i, cfg, rnd);   // 勝率表が無い間は、つよいと同じ
    if (diff === 'easy') return ok[Math.floor(rnd() * ok.length)];
    const model = oppModel(S, j, cfg);
    if (diff === 'normal') {
      if (model.n >= 2 && rnd() < 0.6) {
        const pred = model.oppOk.reduce((b, c) => model.p[c] > model.p[b] ? c : b, model.oppOk[0]);
        let counter;
        if (pred === 'A') counter = (ok.includes('D') && succRate(S.ds[i], cfg) >= 0.5) ? 'D' : 'A';
        else if (pred === 'C') counter = 'A';
        else counter = (ok.includes('C') && S.hp[i] < cfg.hp) ? 'C' : 'A';
        if (ok.includes(counter)) return counter;
      }
      const low = S.hp[i] <= cfg.hp * 0.25, lead = S.hp[i] >= S.hp[j] + cfg.hp * 0.1;
      let w;
      if (low) w = { D: 6, C: 3, A: 1 };
      else if (S.ch[i]) w = { A: 7, D: 2, C: 1 };
      else if (lead) w = { D: 5, A: 3, C: 2 };
      else w = { A: 4, C: 4, D: 2 };
      w.D *= Math.max(0.05, succRate(S.ds[i], cfg));
      if (S.hp[i] >= cfg.hp) w.C *= 0.1;
      return weighted(w, ok, rnd);
    }
    // hard：予測した相手の手の分布に対して、期待値が最大の手を選ぶ（少し乱す）
    if (rnd() < 0.08) return ok[Math.floor(rnd() * ok.length)];
    let best = ok[0], bestV = -1e9;
    for (const c of ok) {
      let v = 0;
      model.oppOk.forEach(o => {
        let s = 0;
        const N = 80;
        for (let t = 0; t < N; t++) {
          const cm = i === 0 ? [c, o] : [o, c];
          const r = resolve(S, cm, rnd, cfg);
          let sc = r.hp[i] - r.hp[j];
          if (r.hp[i] <= 0 && r.hp[j] <= 0) sc -= 15;
          else if (r.hp[i] <= 0) sc -= 120;
          else if (r.hp[j] <= 0) sc += 120;
          if (r.ch[i]) sc += 4;
          s += sc;
        }
        v += (s / N) * model.p[o];
      });
      if (v > bestV) { bestV = v; best = c; }
    }
    return best;
  }

  const api = { DEFAULTS, makeConfig, allowed, succRate, critRate, jgRate, newState, resolve, apply, cpuChoose, setEqTable, setExploit, humanProb };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PCB = api;
})(typeof window !== 'undefined' ? window : globalThis);
