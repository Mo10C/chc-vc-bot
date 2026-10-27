/* =============================================================
   promote-poster.js — ランクアップした人を、急上昇と同じ体裁の画像で投稿する

   index.js から startPromotePoster(client) で起動します。
   昇格の判定は今までどおり Cloudflare の Worker が 23:45 の集計で行い、
   lboard_index/promote の runs.<時刻> に「誰が何から何に上がったか」を書きます。
   この Bot はそれを見つけたら画像を作って連絡事項へ投稿します。

   投稿のしかた（管理コンソール →「メッセージ」の「🎊 ランクアップの画像投稿」= promote.imageMode）
     both … Worker が文字を投稿 → 続けて Bot が画像だけを投稿（既定）
     bot  … Worker は投稿せず、Bot が「文字＋画像」を1通で投稿
     text … 画像は投稿しない（今までどおり Worker の文字だけ）

   ・文面は管理コンソール →「メッセージ」の「ランクアップのお祝い」（Worker と共通）
   ・同じ回を2回投稿しないよう、runs.<時刻>.botAt に投稿した時刻を残します
   ・Bot が止まっていて 12時間以上たった記録は、あとから投稿しません
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { Canvas, enc, channelFor, fsGet, fsReady, renderCard, liveAvatars, rankLabel, buildMessage, md, wd } = shared;

const LATE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_TPL = { head: "🎊 **ランクアップのお知らせ** 🎊", line: "{emoji} **{name}** さんが **{to}** に昇格しました！（{from} → {to}）", foot: "おめでとうございます！" };
const EMOJI = { BRONZE: "🥉", SILVER: "🥈", GOLD: "🥇", PLATINUM: "💎", EMERALD: "💚", DIAMOND: "💠", MASTER: "👑", GRANDMASTER: "🔥", CHALLENGER: "🏆" };
const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
const hhmm = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
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

/* 1回ぶん（1回の集計で上がった人たち）を投稿 */
async function postRun(client, run, withText, force) {
  const rows = (run && Array.isArray(run.rows) ? run.rows : []).filter(r => r && r.to);
  if (!rows.length) throw new Error("ランクアップした人の記録がありません");
  if (!Canvas) throw new Error("@napi-rs/canvas が入っていません");
  const [lp, msgs, icons] = await Promise.all([fsGet("lboard_index/lp"), fsGet("lboard_index/messages"), fsGet("lboard_index/rankicons")]);
  const tpl = Object.assign({}, DEFAULT_TPL, ((msgs || {}).promote) || {});
  const day = run.day || new Date((run.at || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
  if (!force && tpl.pause && day <= tpl.pause) return "一時停止中";
  const emo = t => ((((icons || {}).tiers || {})[t] || {}).emoji || "");
  // 高いティアに上がった人から
  const sorted = rows.slice().sort((a, b) => TIERS.indexOf(b.to) - TIERS.indexOf(a.to) || (b.lp | 0) - (a.lp | 0));
  const list = sorted.map(r => {
    const m = ((lp || {}).members || {})[r.id] || {};
    return { id: r.id, name: r.name || m.name || "—", avatar: m.avatar || "", fromTier: r.from,
      rank: { tier: r.to, division: r.division || "", lp: r.lp | 0 }, value: "UP!", valueColor: "#E0662F" };
  });
  const live = await liveAvatars(client, list.map(x => x.id));
  list.forEach(x => { x.live = live[x.id] || ""; });
  const at = run.at || Date.now();
  const png = await renderCard({ title: "ランクアップ！", sub: md(day) + "（" + wd(day) + "）" + hhmm(at) + " の集計で昇格した人", list, medals: false,
    icons, siteUrl: process.env.SITE_URL || "" });
  const content = withText ? buildMessage(tpl, { count: sorted.length }, sorted.map(p => ({
    emoji: emo(p.to) || EMOJI[p.to] || "🎉", fromEmoji: emo(p.from) || EMOJI[p.from] || "",
    name: p.name, from: p.from, to: p.to, division: p.division || "", lp: p.lp | 0,
    rankLabel: (emo(p.to) ? emo(p.to) + " " : "") + rankLabel({ tier: p.to, division: p.division, lp: p.lp })
  }))) : "";
  const ch = await channelFor(client, !!force);   // 今すぐ投稿（テスト）は実験チャンネルへ
  await ch.send({ content: content || undefined, files: [{ attachment: png, name: "rankup-" + day + ".png" }] });
  return (withText ? "文字＋画像" : "画像") + "を投稿（" + list.length + "人）";
}

function startPromotePoster(client) {
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady() || !Canvas) return;
    busy = true;
    try {
      const doc = await fsGet("lboard_index/promote");
      if (!doc) return;
      const mode = ["both", "bot", "text"].indexOf(doc.imageMode) >= 0 ? doc.imageMode : "both";
      const runs = Object.entries(doc.runs || {}).filter(([, r]) => r && r.at).sort((a, b) => a[1].at - b[1].at);
      // 管理画面の「画像を今すぐ投稿」：いちばん新しい記録を出し直す（テスト用。一時停止は無視）
      if (doc.imgRequestAt && doc.imgRequestAt > (doc.imgHandledAt || 0)) {
        let res;
        const last = runs[runs.length - 1];
        try { res = last ? await postRun(client, last[1], mode === "bot", true) : "まだランクアップの記録がありません"; }
        catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/promote", [[["imgHandledAt"], Date.now()], [["imgLastResult"], "今すぐ投稿（実験チャンネル） → " + res]]);
        console.log("[promote] 今すぐ投稿: " + res);
      }
      if (mode === "text") return;
      const now = Date.now();
      for (const [key, r] of runs) {
        if (r.botAt || now - r.at > LATE_MS) continue;
        let res;
        try { res = await postRun(client, r, mode === "bot", false); } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/promote", [[["runs", key, "botAt"], Date.now()], [["imgLastResult"], (r.day || "") + " → " + res]]);
        console.log("[promote] " + (r.day || key) + ": " + res);
      }
    } catch (e) { console.error("[promote]", e.message); }
    finally { busy = false; }
  };
  const onReady = () => { if (started) return; started = true; setTimeout(tick, 11000); };
  client.once("clientReady", onReady);
  client.once("ready", onReady);
  const t = setInterval(tick, 60 * 1000);
  t.unref && t.unref();
}

module.exports = { startPromotePoster, postRun };
