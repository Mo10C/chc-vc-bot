/* =============================================================
   snapshot-poster.js — 先生スナップショットの結果を、急上昇と同じ体裁の画像で投稿する

   index.js から startSnapshotPoster(client) で起動します。
   集計（順位とポイント）は今までどおり Cloudflare の Worker が 23:45 に行い、
   lboard_index/snapshot の results に書きます。この Bot はそれを見つけたら画像を作って投稿します。

   投稿のしかた（管理コンソール →「先生スナップショット」の「画像の投稿」で選ぶ = snapshot.imageMode）
     both … Worker が文字を投稿 → 続けて Bot が画像だけを投稿（既定）
     bot  … Worker は投稿せず、Bot が「文字＋画像」を1通で投稿
     text … 画像は投稿しない（今までどおり Worker の文字だけ）
   最終回の「代表先生の表彰」も同じように画像で投稿します。

   ・文面は管理コンソール →「メッセージ」の「先生スナップショットの結果」「代表先生の表彰」（Worker と共通）
   ・同じ回を2回投稿しないよう、results.<日付>.botAt / finalBotAt に投稿した時刻を残します
   ・Bot が止まっていて 12時間以上たった結果は、あとから投稿しません
   ・管理コンソールの「画像を今すぐ投稿」（imgRequestAt）で、いつでも出し直せます
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { Canvas, enc, fsGet, fsReady, renderCard, liveAvatars, rankLabel, rankOfAbs, buildMessage, md, wd, MEDAL_TXT } = shared;

const LATE_MS = 12 * 60 * 60 * 1000;
const MARU = ["", "①", "②", "③", "④", "⑤", "⑥"];

// core.js の既定の文面と同じ（管理画面で保存していないとき用）
const DEFAULT_MSG = {
  snapshot: { head: "📸 **{label}{maru}**　{md} {time} 時点", line: "{medal} **{rank}位　{name}**　{rankLabel}　**+{point}pt**", foot: "おつかれさまでした！" },
  final: { head: "🏆 **{title} 決定！** 🏆\n{rounds}回の{label}の合計ポイントで、{title}{n}名が決まりました。",
           line: "{medal} **{name}**　**{total}pt**{detail}", foot: "おめでとうございます！ 代表としてよろしくお願いします 🎉" }
};
const hhmm = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
const pathOf = segs => segs.map(s => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : "`" + s + "`").join(".");

/* 入れ子のフィールドを1つだけ書き換える（results.`2026-10-31`.botAt など）。他の項目は触らない */
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

async function ctx(client) {
  const chId = process.env.DISCORD_SCHEDULE_CHANNEL_ID;
  if (!chId) throw new Error("DISCORD_SCHEDULE_CHANNEL_ID が未設定です（Railway の Variables）");
  if (!Canvas) throw new Error("@napi-rs/canvas が入っていません");
  const [lp, msgs, icons] = await Promise.all([fsGet("lboard_index/lp"), fsGet("lboard_index/messages"), fsGet("lboard_index/rankicons")]);
  const emo = t => ((((icons || {}).tiers || {})[t] || {}).emoji || "");
  return { ch: await client.channels.fetch(chId), lp: lp || {}, msgs: msgs || {}, icons, emo };
}
const tplOf = (msgs, key) => Object.assign({}, DEFAULT_MSG[key], msgs[key] || {});
const paused = (tpl, day) => !!(tpl.pause && day <= tpl.pause);

/* 1回ぶんの結果を投稿。withText：文面も一緒に出す（Worker が文字を投稿していないとき） */
async function postRound(client, snap, day, withText, force) {
  const r = (snap.results || {})[day];
  if (!r || !Array.isArray(r.rows) || !r.rows.length) throw new Error(day + " の結果がありません");
  const c = await ctx(client);
  const tpl = tplOf(c.msgs, "snapshot");
  if (!force && paused(tpl, day)) return "一時停止中";
  const dates = (snap.dates || []).slice().sort();
  const round = dates.indexOf(day) + 1, maru = MARU[round] || (round ? "第" + round + "回" : "");
  const label = String(snap.label || "先生スナップショット");
  const rows = r.rows.slice().sort((a, b) => (a.rank | 0) - (b.rank | 0));
  const list = rows.map(x => {
    const m = (c.lp.members || {})[x.id] || {};
    return { id: x.id, name: x.name || m.name || "—", avatar: m.avatar || "",
      rank: x.tier ? { tier: x.tier, division: x.division || "", lp: x.lp | 0 } : rankOfAbs(x.abs | 0),
      value: "+" + (x.point | 0) + "pt" };
  });
  const live = await liveAvatars(client, list.map(x => x.id));
  list.forEach(x => { x.live = live[x.id] || ""; });
  const at = r.at || Date.now();
  const png = await renderCard({ title: label + maru, sub: md(day) + "（" + wd(day) + "）" + hhmm(at) + " 時点のランク", list, icons: c.icons, siteUrl: process.env.SITE_URL || "" });
  const content = withText ? buildMessage(tpl, { label, maru, round, md: md(day), date: day, time: hhmm(at), hhmm: hhmm(at) },
    rows.map(x => ({ medal: MEDAL_TXT[(x.rank | 0) - 1] || "✨", rank: x.rank, name: x.name,
      rankLabel: (c.emo(x.tier) ? c.emo(x.tier) + " " : "") + rankLabel({ tier: x.tier, division: x.division, lp: x.lp }), point: x.point }))) : "";
  await c.ch.send({ content: content || undefined, files: [{ attachment: png, name: "snapshot-" + day + ".png" }] });
  return (withText ? "文字＋画像" : "画像") + "を投稿（" + list.length + "人）";
}

/* 代表先生の表彰 */
async function postFinal(client, snap, withText, force) {
  const chosen = Array.isArray(snap.final) ? snap.final : [];
  if (!chosen.length) throw new Error("表彰の結果がありません");
  const c = await ctx(client);
  const tpl = tplOf(c.msgs, "final");
  const dates = (snap.dates || []).slice().sort();
  const day = dates[dates.length - 1] || "";
  if (!force && paused(tpl, day)) return "一時停止中";
  const title = String(snap.finalTitle || "代表先生"), label = String(snap.label || "先生スナップショット");
  const detailOf = t => dates.filter(d => t.per && t.per[d] != null).map(d => (MARU[dates.indexOf(d) + 1] || "") + (t.per[d] | 0) + "pt").join(" + ");
  const list = chosen.map(t => {
    const m = (c.lp.members || {})[t.id] || {};
    return { id: t.id, name: t.name || m.name || "—", avatar: m.avatar || "",
      rank: m.tier ? { tier: m.tier, division: m.division || "", lp: m.lp | 0 } : (t.lastAbs ? rankOfAbs(t.lastAbs) : null),
      note: detailOf(t), value: (t.total | 0) + "pt", valueColor: "#C08A12" };
  });
  const live = await liveAvatars(client, list.map(x => x.id));
  list.forEach(x => { x.live = live[x.id] || ""; });
  const png = await renderCard({ title: title + " 決定！", sub: dates.length + "回の" + label + "の合計ポイント", list, icons: c.icons, siteUrl: process.env.SITE_URL || "" });
  const at = snap.finalAt || Date.now();
  const content = withText ? buildMessage(tpl, { title, label, rounds: dates.length, n: chosen.length, md: day ? md(day) : "", date: day, time: hhmm(at) },
    chosen.map((t, i) => ({ medal: MEDAL_TXT[i] || "✨", rank: i + 1, name: t.name, total: t.total | 0, detail: detailOf(t) ? "（" + detailOf(t) + "）" : "" }))) : "";
  await c.ch.send({ content: content || undefined, files: [{ attachment: png, name: "snapshot-final.png" }] });
  return "表彰の" + (withText ? "文字＋画像" : "画像") + "を投稿（" + list.length + "人）";
}

function startSnapshotPoster(client) {
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady() || !Canvas) return;
    busy = true;
    try {
      const snap = await fsGet("lboard_index/snapshot");
      if (!snap) return;
      const mode = ["both", "bot", "text"].indexOf(snap.imageMode) >= 0 ? snap.imageMode : "both";
      const now = Date.now();
      // 管理画面の「画像を今すぐ投稿」（テスト・出し直し用。一時停止は無視）
      if (snap.imgRequestAt && snap.imgRequestAt > (snap.imgHandledAt || 0)) {
        let res;
        try {
          res = snap.imgRequestFinal ? await postFinal(client, snap, mode === "bot", true)
                                     : await postRound(client, snap, String(snap.imgRequestDay || ""), mode === "bot", true);
        } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/snapshot", [[["imgHandledAt"], Date.now()], [["imgLastResult"], (snap.imgRequestFinal ? "表彰" : String(snap.imgRequestDay || "")) + " → " + res]]);
        console.log("[snapshot] 今すぐ投稿: " + res);
      }
      if (mode === "text") return;
      // 新しい結果（Worker が書いた直後）を投稿
      for (const [day, r] of Object.entries(snap.results || {}).sort()) {
        if (!r || r.botAt || !r.at || now - r.at > LATE_MS) continue;
        let res;
        try { res = await postRound(client, snap, day, mode === "bot", false); } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/snapshot", [[["results", day, "botAt"], Date.now()], [["imgLastResult"], day + " → " + res]]);
        console.log("[snapshot] " + day + ": " + res);
      }
      if (snap.finalAt && !snap.finalBotAt && now - snap.finalAt < LATE_MS && Array.isArray(snap.final) && snap.final.length) {
        let res;
        try { res = await postFinal(client, snap, mode === "bot", false); } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/snapshot", [[["finalBotAt"], Date.now()], [["imgLastResult"], "表彰 → " + res]]);
        console.log("[snapshot] 表彰: " + res);
      }
    } catch (e) { console.error("[snapshot]", e.message); }
    finally { busy = false; }
  };
  const onReady = () => { if (started) return; started = true; setTimeout(tick, 8000); };
  client.once("clientReady", onReady);
  client.once("ready", onReady);
  const t = setInterval(tick, 60 * 1000);
  t.unref && t.unref();
}

module.exports = { startSnapshotPoster, postRound, postFinal };
