/* =============================================================
   stamp-poster.js — スタンプカードをコンプリートした人を Discord でお祝いする

   index.js から startStampPoster(client) で起動します。
   スタンプは生徒がサイト（stamp.html）で押し、そろったら lboard_index/stamps の
   users.<id>.completeAt にサイトが時刻を書きます。この Bot はそれを見つけたら連絡事項へ投稿し、
   users.<id>.postedAt を書きます（同じ人を2回お祝いしないため）。

   lboard_index/stamp（管理コンソール →「スタンプ」）
     post.enabled     … オフなら投稿しない
     post.complete    … 達成（ビンゴ／コンプリート）の文面。{name} {mention} {count} {total} {lines} {title} が置きかわる
     post.fullEnabled … ぜんぶうめたときも投稿するか
     post.full        … ぜんぶうめたときの文面（同じ置きかえ）。サイトが users.<id>.fullAt を書き、Bot が fullPostedAt を書く
     testRequestAt … 「🧪 実験チャンネルにテスト投稿」。testHandledAt / testLastResult を Bot が書く
   ・コンプリートから3日以上たった分は、あとから投稿しません（Bot が止まっていたときなど）
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { enc, channelFor, fsGet, fsReady, DUMMY_NOTE } = shared;

const LATE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_TEXT = "🎉 **{name}** さんが「{title}」で **ビンゴ！**（{lines}ライン・{count}マス）\nおめでとうございます！ まだの人も、いっしょに遊ぼう 🎮";
const DEFAULT_FULL = "🏆 **{name}** さんが「{title}」のカードを **ぜんぶうめました**！（{count}マス・{lines}ライン）\nすごい！ おめでとうございます 🎊";

// そろったライン数（core.js の stampLines と同じ数え方。24マス＋FREE なら真ん中が FREE）
function linesOf(cfg, stamps) {
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [], n = tasks.length, bingo = cfg.mode !== "card";
  const free0 = cfg.free == null ? true : !!cfg.free;
  const cols = [3, 4, 5].includes(cfg.cols) ? cfg.cols : Math.max(2, Math.min(5, Math.ceil(Math.sqrt(n + (bingo && free0 ? 1 : 0)))));
  const cells = tasks.map(t => t.id);
  if (bingo && free0 && cols % 2 === 1 && n + 1 === cols * cols) cells.splice((cols * cols - 1) / 2, 0, "__free");
  const N = cells.length, rows = Math.ceil(N / cols), has = i => cells[i] === "__free" || !!(stamps && stamps[cells[i]]);
  const L = [];
  for (let r = 0; r < rows; r++) { if ((r + 1) * cols > N) break; L.push(Array.from({ length: cols }, (_, c) => r * cols + c)); }
  for (let c = 0; c < cols; c++) { const a = []; for (let r = 0; r < rows; r++) if (r * cols + c < N) a.push(r * cols + c); if (a.length === rows && rows > 1) L.push(a); }
  if (rows === cols && N === cols * cols) { L.push(Array.from({ length: cols }, (_, i) => i * cols + i)); L.push(Array.from({ length: cols }, (_, i) => i * cols + (cols - 1 - i))); }
  return L.filter(a => a.every(has)).length;
}
const pathOf = segs => segs.map(s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : "`" + s + "`").join(".");

async function fsSet(doc, pairs) {
  const fields = {}, mask = [];
  pairs.forEach(([segs, value]) => {
    let cur = fields;
    segs.forEach((k, i) => {
      if (i === segs.length - 1) cur[k] = enc(value);
      else { cur[k] = cur[k] || { mapValue: { fields: {} } }; cur = cur[k].mapValue.fields; }
    });
    mask.push(pathOf(segs));
  });
  const base = "https://firestore.googleapis.com/v1/projects/" + process.env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/";
  const q = mask.map(p => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const r = await fetch(base + doc + "?key=" + process.env.FIREBASE_API_KEY + "&" + q, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
}
const fill = (t, v) => String(t || "").replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));

function textFor(cfg, id, u, kind) {
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
  const need = cfg.mode === "card" && cfg.need > 0 ? Math.min(cfg.need, tasks.length) : tasks.length;
  const count = tasks.filter(t => u.stamps && u.stamps[t.id]).length;
  const discordId = /^u_\d+$/.test(id) ? id.slice(2) : "";
  const tx = kind === "full" ? ((cfg.post && cfg.post.full) || DEFAULT_FULL) : ((cfg.post && cfg.post.complete) || DEFAULT_TEXT);
  return fill(tx, {
    name: u.name || "—", mention: discordId ? "<@" + discordId + ">" : (u.name || "—"),
    count, total: need, lines: linesOf(cfg, u.stamps), title: cfg.title || "スタンプカード" });
}

function startStampPoster(client) {
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady()) return;
    busy = true;
    try {
      const cfg = await fsGet("lboard_index/stamp");
      if (!cfg) return;
      // テスト投稿（実験チャンネル）
      if (cfg.testRequestAt && cfg.testRequestAt > (cfg.testHandledAt || 0)) {
        let res;
        try {
          const rec = (await fsGet("lboard_index/stamps")) || {};
          const ent = Object.entries(rec.users || {})[0];
          const [id, u] = ent || ["u_0", { name: "テスト生徒", stamps: {} }];
          // テストはコンプリートしたことにして出す
          const all = {}; (cfg.tasks || []).forEach(t => { all[t.id] = { at: Date.now() }; });
          const ch = await channelFor(client, true);
          const uu = Object.assign({}, u, { stamps: all });
          await ch.send({ content: DUMMY_NOTE + textFor(cfg, id, uu, "complete"), allowedMentions: { parse: [] } });
          if (!cfg.post || cfg.post.fullEnabled !== false) await ch.send({ content: DUMMY_NOTE + textFor(cfg, id, uu, "full"), allowedMentions: { parse: [] } });
          res = "投稿しました";
        } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/stamp", [[["testHandledAt"], Date.now()], [["testLastResult"], "テスト → " + res]]);
        console.log("[stamp] テスト投稿: " + res);
      }
      if (cfg.post && cfg.post.enabled === false) return;
      const rec = await fsGet("lboard_index/stamps");
      const now = Date.now();
      const fullOn = !cfg.post || cfg.post.fullEnabled !== false;
      for (const [id, u] of Object.entries((rec && rec.users) || {})) {
        if (!u) continue;
        // [達成の時刻, 投稿済みの印, 種類]
        const jobs = [["completeAt", "postedAt", "complete"]].concat(fullOn ? [["fullAt", "fullPostedAt", "full"]] : []);
        for (const [atK, doneK, kind] of jobs) {
          if (!u[atK] || u[doneK]) continue;
          // 達成と「ぜんぶうめた」が同時なら、ぜんぶうめたほうだけ投稿する
          if (kind === "complete" && fullOn && u.fullAt && !u.fullPostedAt) { await fsSet("lboard_index/stamps", [[["users", id, doneK], -2]]); continue; }
          if (now - u[atK] > LATE_MS) { await fsSet("lboard_index/stamps", [[["users", id, doneK], -1]]); continue; }   // 古い分は出さない
          try {
            const ch = await channelFor(client, false);
            await ch.send({ content: textFor(cfg, id, u, kind), allowedMentions: { parse: ["users"] } });
            await fsSet("lboard_index/stamps", [[["users", id, doneK], Date.now()]]);
            console.log("[stamp] " + (kind === "full" ? "ぜんぶうめた" : "達成") + "のお祝い: " + (u.name || id));
          } catch (e) { console.error("[stamp] 投稿に失敗", e.message); }
        }
      }
    } catch (e) { console.error("[stamp]", e.message); }
    finally { busy = false; }
  };
  const onReady = () => { if (started) return; started = true; setTimeout(tick, 15000); };
  client.once("clientReady", onReady);
  client.once("ready", onReady);
  const t = setInterval(tick, 60 * 1000);
  t.unref && t.unref();
}

module.exports = { startStampPoster };
