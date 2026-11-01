/* =============================================================
   graduation-poster.js — 卒業式の投稿（卒業証書・感謝状を1人ずつDiscordへ）

   index.js から startGraduationPoster(client) で起動します。
   画像はサイトの卒業証書（album.html）と同じものを、管理コンソールの画面が作って
   lboard_index/gradimg_<番号> に置きます（{ img: "data:image/jpeg;base64,…" }）。
   この Bot は lboard_index/gradpost の依頼を見つけたら、上から順に投稿するだけです。

   lboard_index/gradpost
     requestAt  … 依頼した時刻（handledAt より新しければ投稿する）
     request    … { at, test, dummy, messages: [{ content, imgs: ["gradimg_0", …] }] }
                   test  … true なら実験チャンネル（管理コンソール →「メッセージ」→「🧪 実験チャンネル」）
                   dummy … true なら1通目の頭に「テスト投稿（ダミーデータ）」と付ける
     cancelAt   … 管理コンソールの「止める」。これより前の依頼は、途中でやめる
     handledAt / progress / lastResult … Bot が書く（管理コンソールに表示）

   文面は管理コンソール →「卒業証書」→「🎓 卒業式の投稿」で編集します（ここでは手を加えません）。
   1通ずつ 1.5秒あけて送ります（Discord の連投制限のため）。
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { enc, channelFor, fsGet, fsReady, DUMMY_NOTE } = shared;

const DOC = "lboard_index/gradpost";
const STALE_MS = 60 * 60 * 1000;      // 1時間以上前の依頼は、Bot が止まっていた分なので出さない
const GAP_MS = 1500;

async function fsPatch(doc, obj) {
  const fields = {}; Object.entries(obj).forEach(([k, v]) => { fields[k] = enc(v); });
  const q = Object.keys(obj).map(p => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const base = "https://firestore.googleapis.com/v1/projects/" + process.env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/";
  const r = await fetch(base + doc + "?key=" + process.env.FIREBASE_API_KEY + "&" + q, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fileOf(key, i) {
  const d = await fsGet("lboard_index/" + key);
  const m = d && String(d.img || "").match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!m) throw new Error("画像 " + key + " が見つかりません（管理コンソールからもう一度投稿してください）");
  return { attachment: Buffer.from(m[2], "base64"), name: (d.name || key) + "-" + (i + 1) + (m[1] === "png" ? ".png" : ".jpg") };
}

async function postAll(client, req) {
  const msgs = Array.isArray(req.messages) ? req.messages : [];
  if (!msgs.length) return "投稿するものがありません";
  const ch = await channelFor(client, !!req.test);
  let sent = 0;
  for (let i = 0; i < msgs.length; i++) {
    // 管理コンソールで「止める」を押されたら、そこでやめる
    if (i && i % 3 === 0) {
      const cur = await fsGet(DOC).catch(() => null);
      if (cur && cur.cancelAt && cur.cancelAt > req.at) return "途中で止めました（" + sent + " / " + msgs.length + "通）";
      await fsPatch(DOC, { progress: sent + " / " + msgs.length }).catch(() => {});
    }
    const m = msgs[i] || {};
    const files = [];
    for (const [k, key] of (m.imgs || []).entries()) files.push(await fileOf(key, k));
    let content = String(m.content || "").slice(0, 1900);
    if (req.dummy && i === 0) content = DUMMY_NOTE + content;
    if (!content && !files.length) continue;
    await ch.send({ content: content || undefined, files, allowedMentions: { parse: ["users"] } });
    sent++;
    await sleep(GAP_MS);
  }
  return sent + "通を投稿しました";
}

function startGraduationPoster(client) {
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady()) return;
    busy = true;
    try {
      const doc = await fsGet(DOC);
      if (!doc || !doc.request || !doc.requestAt || doc.requestAt <= (doc.handledAt || 0)) return;
      const req = doc.request;
      let res;
      if (Date.now() - (req.at || 0) > STALE_MS) res = "古い依頼なので投稿しませんでした（もう一度押してください）";
      else if (doc.cancelAt && doc.cancelAt > req.at) res = "止めました";
      else {
        await fsPatch(DOC, { handledAt: doc.requestAt, progress: "0 / " + ((req.messages || []).length), lastResult: "投稿中…" });
        try { res = await postAll(client, req); } catch (e) { res = "失敗：" + e.message; }
      }
      const where = req.test ? "実験チャンネル" : "本番（連絡事項）";
      await fsPatch(DOC, { handledAt: doc.requestAt, doneAt: Date.now(), progress: "", lastResult: where + " → " + res });
      console.log("[graduation] " + where + " → " + res);
    } catch (e) { console.error("[graduation]", e.message); }
    finally { busy = false; }
  };
  const onReady = () => { if (started) return; started = true; setTimeout(tick, 13000); };
  client.once("clientReady", onReady);
  client.once("ready", onReady);
  const t = setInterval(tick, 15 * 1000);   // 押してから15秒以内に始まる
  t.unref && t.unref();
}

module.exports = { startGraduationPoster };
