/* =============================================================
   stamp-poster.js — スタンプカードをコンプリートした人を Discord でお祝いする

   index.js から startStampPoster(client) で起動します。
   スタンプは生徒がサイト（stamp.html）で押し、そろったら lboard_index/stamps の
   users.<id>.completeAt にサイトが時刻を書きます。この Bot はそれを見つけたら連絡事項へ投稿し、
   users.<id>.postedAt を書きます（同じ人を2回お祝いしないため）。

   lboard_index/stamp（管理コンソール →「スタンプ」）
     post.enabled  … オフなら投稿しない
     post.complete … 文面。{name} {mention} {count} {total} {title} が置きかわる
     testRequestAt … 「🧪 実験チャンネルにテスト投稿」。testHandledAt / testLastResult を Bot が書く
   ・コンプリートから3日以上たった分は、あとから投稿しません（Bot が止まっていたときなど）
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { enc, channelFor, fsGet, fsReady, DUMMY_NOTE } = shared;

const LATE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_TEXT = "🎉 **{name}** さんが「{title}」のスタンプカードを **コンプリート**！（{count} / {total}マス）\nおめでとうございます！ まだの人も、いっしょに遊ぼう 🎮";
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

function textFor(cfg, id, u) {
  const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
  const need = cfg.need > 0 ? Math.min(cfg.need, tasks.length) : tasks.length;
  const count = tasks.filter(t => u.stamps && u.stamps[t.id]).length;
  const discordId = /^u_\d+$/.test(id) ? id.slice(2) : "";
  return fill((cfg.post && cfg.post.complete) || DEFAULT_TEXT, {
    name: u.name || "—", mention: discordId ? "<@" + discordId + ">" : (u.name || "—"),
    count, total: need, title: cfg.title || "スタンプカード" });
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
          await ch.send({ content: DUMMY_NOTE + textFor(cfg, id, Object.assign({}, u, { stamps: all })), allowedMentions: { parse: [] } });
          res = "投稿しました";
        } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/stamp", [[["testHandledAt"], Date.now()], [["testLastResult"], "テスト → " + res]]);
        console.log("[stamp] テスト投稿: " + res);
      }
      if (cfg.post && cfg.post.enabled === false) return;
      const rec = await fsGet("lboard_index/stamps");
      const now = Date.now();
      for (const [id, u] of Object.entries((rec && rec.users) || {})) {
        if (!u || !u.completeAt || u.postedAt) continue;
        if (now - u.completeAt > LATE_MS) { await fsSet("lboard_index/stamps", [[["users", id, "postedAt"], -1]]); continue; }   // 古い分は出さない
        try {
          const ch = await channelFor(client, false);
          await ch.send({ content: textFor(cfg, id, u), allowedMentions: { parse: ["users"] } });
          await fsSet("lboard_index/stamps", [[["users", id, "postedAt"], Date.now()]]);
          console.log("[stamp] コンプリートのお祝い: " + (u.name || id));
        } catch (e) { console.error("[stamp] 投稿に失敗", e.message); }
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
