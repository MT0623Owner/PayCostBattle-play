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
 * コマンド：'A'=攻撃、'C'=貯める、'D'=防御
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    hp: 100,            // 初期HP・上限
    attackCost: 5,      // 攻撃のコスト
    damage: 10,         // 攻撃ダメージ
    heal: 5,            // 貯めるの回復量
    chargeMult: 2,      // 貯め後の攻撃倍率
    drain: 5,           // クリティカルのドレイン量
    mirror: 2,          // あいこ（同じ手）のペナルティ
    critBase: 0.10,     // クリティカル基本率
    critK: 0.008,       // HP差1あたりの上昇
    critCap: 0.50,      // 上限
    defStep: 0.25,      // 防御の成功率の低下幅（連続1回あたり）
    noDefAfterCharge: 0 // 1なら、貯めた次は防御不可（既定は可）
  };

  function makeConfig(patch) { return Object.assign({}, DEFAULTS, patch || {}); }

  function allowed(last, cfg) {
    cfg = cfg || DEFAULTS;
    if (last === null || last === 'A') return ['A', 'C', 'D'];
    if (last === 'C') return cfg.noDefAfterCharge ? ['A', 'C'] : ['A', 'C', 'D'];
    return ['A', 'D']; // 防御の次は貯める不可
  }

  // ds＝直前までの連続防御回数。1回目100%、以後 defStep ずつ低下（0未満にはならない）
  function succRate(ds, cfg) { return Math.max(0, 1 - cfg.defStep * ds); }

  // 自分(i)のクリティカル率。自分のHPが相手より低いほど上がる
  function critRate(hp, i, cfg) {
    return Math.min(cfg.critCap, cfg.critBase + Math.max(0, hp[1 - i] - hp[i]) * cfg.critK);
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
                     crit: { hit: false, rate: 0, amount: 0 } };
        if (cmd[j] !== 'D') {
          delta[j] -= dmg;
        } else {
          const sr = succRate(S.ds[j], cfg);
          ev.succ = sr;
          if (rnd() < sr) ev.blocked = true;
          else { delta[j] -= dmg; ev.defFailed = true; failed[j] = true; }
        }
        const rate = critRate(S.hp, i, cfg);
        ev.crit.rate = rate;
        if (rnd() < rate) {
          const dr = cfg.drain * (cmd[j] === 'C' ? 2 : 1);
          delta[j] -= dr; delta[i] += dr;
          ev.crit.hit = true; ev.crit.amount = dr;
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
    const oppOk = allowed(last, cfg);
    const gT = oppOk.reduce((a, c) => a + glob[c], 0), cT = oppOk.reduce((a, c) => a + cond[c], 0);
    const wc = Math.min(0.8, n / (n + 2));
    const p = {};
    oppOk.forEach(c => { p[c] = (1 - wc) * glob[c] / gT + wc * cond[c] / cT; });
    return { oppOk, p, n };
  }

  /** CPUの手。相手の現在の手は見ない（履歴と盤面のみ）。diff＝'easy'|'normal'|'hard' */
  function cpuChoose(S, i, diff, cfg, rnd) {
    rnd = rnd || Math.random;
    const j = 1 - i, ok = allowed(S.last[i], cfg);
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

  const api = { DEFAULTS, makeConfig, allowed, succRate, critRate, newState, resolve, apply, cpuChoose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PCB = api;
})(typeof window !== 'undefined' ? window : globalThis);
