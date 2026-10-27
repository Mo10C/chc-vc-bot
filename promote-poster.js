/* =============================================================
   promote-poster.js — ランクアップした人を、1人ずつ豪華なお祝い画像で投稿する

   index.js から startPromotePoster(client) で起動します。
   昇格の判定は今までどおり Cloudflare の Worker が 23:45 の集計で行い、
   lboard_index/promote の runs.<時刻> に「誰が何から何に上がったか」を書きます。
   この Bot はそれを見つけたら画像を作って連絡事項へ投稿します。

   投稿のしかた（管理コンソール →「メッセージ」の「🎊 ランクアップの画像投稿」= promote.imageMode）
     bot  … Worker は投稿せず、Bot が1人ずつ「お祝いの一文＋画像」を投稿（既定）
            1通目の頭に見出し、最後の1通にしめの一言
     both … Worker が文字をまとめて投稿 → 続けて Bot が画像だけを1人ずつ投稿
     text … 画像は投稿しない（今までどおり Worker の文字だけ）

   ・文面は管理コンソール →「メッセージ」の「ランクアップのお祝い」（Worker と共通）
   ・同じ回を2回投稿しないよう、runs.<時刻>.botAt に投稿した時刻を残します
   ・Bot が止まっていて 12時間以上たった記録は、あとから投稿しません
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { Canvas, enc, channelFor, fsGet, fsReady, liveAvatars, rankLabel, buildMessage, fill, md, wd,
  setupFonts, loadImg, rankImg, rr, star, clean, fitText, dummyPlayers, DUMMY_NOTE } = shared;

const LATE_MS = 12 * 60 * 60 * 1000;
const MASCOT = "assets/rankup-mascot.png";   // お祝い画像の右下に入れる絵（差し替えるときはこのファイルを置きかえる）
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

/* ---------------- 1人ずつの、豪華なお祝い画像（1200×675） ---------------- */
const TIER_COLOR = { IRON: "#8A8F98", BRONZE: "#C07A43", SILVER: "#A9BCCD", GOLD: "#F2B53C", PLATINUM: "#3CC2B8",
  EMERALD: "#25C07E", DIAMOND: "#6E8CFF", MASTER: "#B65CF0", GRANDMASTER: "#F0484A", CHALLENGER: "#FFD25A" };
// 毎回同じ並びになる乱数（紙ふぶきの位置）
function rng(seed) { let x = 0; for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }

async function renderRankUp(p, icons, siteUrl, day) {
  setupFonts();
  const W = 1200, H = 675, cv = Canvas.createCanvas(W, H), g = cv.getContext("2d");
  const col = TIER_COLOR[p.rank.tier] || "#F2B53C", R = rng(p.id + day);
  // 背景：深い色 → 新しいティアの色
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0E1426"); bg.addColorStop(0.55, "#1A1F3D"); bg.addColorStop(1, hexA(col, 0.55));
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // 光の筋（アイコンの後ろから放射状に）
  const cx = 300, cy = 345;
  g.save(); g.translate(cx, cy);
  for (let i = 0; i < 12; i++) {          // 光の筋は控えめに（12本・うすく・アイコンのまわりだけ）
    g.rotate(Math.PI * 2 / 12);
    const lg = g.createLinearGradient(0, 0, 480, 0); lg.addColorStop(0, hexA(col, 0.22)); lg.addColorStop(1, hexA(col, 0));
    g.beginPath(); g.moveTo(0, 0); g.lineTo(480, -34); g.lineTo(480, 34); g.closePath(); g.fillStyle = lg; g.fill();
  }
  g.restore();
  const glow = g.createRadialGradient(cx, cy, 60, cx, cy, 300); glow.addColorStop(0, hexA(col, 0.45)); glow.addColorStop(1, hexA(col, 0));
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  // 紙ふぶき
  const CONF = ["#FFD25A", "#FF6B8A", "#5BC8FF", "#7CF29A", "#FFFFFF", col];
  for (let i = 0; i < 28; i++) {          // 紙ふぶきは少なめ。上と下のふちだけ（文字にかからない）
    const x = 40 + R() * (W - 80), y = R() < 0.5 ? 40 + R() * 50 : H - 90 + R() * 50, w = 6 + R() * 8, h = 3 + R() * 4;
    g.save(); g.translate(x, y); g.rotate(R() * Math.PI); g.globalAlpha = 0.45 + R() * 0.35;
    g.fillStyle = CONF[(R() * CONF.length) | 0]; g.fillRect(-w / 2, -h / 2, w, h); g.restore();
  }
  [[470, 110, 12], [1110, 120, 9], [1120, 560, 11], [90, 600, 8]].forEach(([x, y, r]) => star(g, x, y, r, "rgba(255,240,190,.75)"));
  // 金の枠
  g.lineWidth = 6; g.strokeStyle = "#E8C25A"; rr(g, 18, 18, W - 36, H - 36, 28); g.stroke();
  g.lineWidth = 2; g.strokeStyle = "rgba(232,194,90,.55)"; rr(g, 32, 32, W - 64, H - 64, 20); g.stroke();

  // 左：アイコン（光る輪）
  const r = 140;
  g.save(); g.shadowColor = col; g.shadowBlur = 50;
  g.beginPath(); g.arc(cx, cy, r + 14, 0, Math.PI * 2);
  const ring = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r); ring.addColorStop(0, "#FFF1B8"); ring.addColorStop(0.5, "#E8B23A"); ring.addColorStop(1, col);
  g.fillStyle = ring; g.fill(); g.restore();
  let im = null;
  for (const u of [p.live, p.avatar]) { if (u && (im = await loadImg(u))) break; }
  g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
  if (im) g.drawImage(im, cx - r, cy - r, r * 2, r * 2);
  else { g.fillStyle = col; g.fillRect(cx - r, cy - r, r * 2, r * 2); g.fillStyle = "#fff"; g.font = "900 130px JPB"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(clean(p.name).slice(0, 1), cx, cy + 6); }
  g.restore();
  // アイコンの下に新しいティアの紋章を重ねる
  const cache = {};
  const toIm = await rankImg(p.rank.tier, icons, siteUrl, cache);
  if (toIm) { const ih = 110, iw = Math.min(ih * 1.6, toIm.width * ih / toIm.height); g.save(); g.shadowColor = "rgba(0,0,0,.5)"; g.shadowBlur = 16; g.drawImage(toIm, cx - iw / 2, cy + r - 40, iw, ih); g.restore(); }

  // 右：文字
  const X = 520;
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  const tg = g.createLinearGradient(X, 90, X, 200); tg.addColorStop(0, "#FFF4C2"); tg.addColorStop(0.5, "#FFD25A"); tg.addColorStop(1, "#E59A1E");
  g.font = "700 120px SG"; g.lineWidth = 10; g.strokeStyle = "rgba(60,30,0,.55)"; g.strokeText("RANK UP!", X, 190);
  g.fillStyle = tg; g.fillText("RANK UP!", X, 190);
  // 名前
  g.fillStyle = "#FFFFFF"; g.font = "900 64px JPB";
  let fs = 64; while (fs > 34 && g.measureText(clean(p.name) + " さん").width > W - X - 70) { fs -= 2; g.font = "900 " + fs + "px JPB"; }
  g.fillText(fitText(g, clean(p.name), W - X - 70 - g.measureText(" さん").width), X, 300);
  const nw = g.measureText(fitText(g, clean(p.name), W - X - 70 - g.measureText(" さん").width)).width;
  g.font = "900 " + Math.round(fs * 0.55) + "px JPB"; g.fillStyle = "#FFE7A6"; g.fillText(" さん", X + nw, 300);
  // 前のティア → 新しいティア
  const box = { x: X, y: 330, w: W - X - 60, h: 150 };
  rr(g, box.x, box.y, box.w, box.h, 26); g.fillStyle = "rgba(255,255,255,.10)"; g.fill();
  g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.25)"; g.stroke();
  const fromIm = await rankImg(p.fromTier, icons, siteUrl, cache);
  let tx = box.x + 26;
  if (fromIm) { const ih = 70, iw = Math.min(ih * 1.6, fromIm.width * ih / fromIm.height); g.save(); g.globalAlpha = 0.6; g.drawImage(fromIm, tx, box.y + 22, iw, ih); g.restore();
    g.fillStyle = "rgba(255,255,255,.7)"; g.font = "700 20px SG"; g.textAlign = "center"; g.fillText(p.fromTier, tx + iw / 2, box.y + 122); g.textAlign = "left"; tx += iw + 22; }
  g.fillStyle = "#FFD25A"; g.font = "700 56px SG"; g.fillText("→", tx, box.y + 92); tx += 76;
  if (toIm) { const ih = 96, iw = Math.min(ih * 1.6, toIm.width * ih / toIm.height); g.drawImage(toIm, tx, box.y + 14, iw, ih); tx += iw + 18; }
  // 新しいティアの名前だけ（LP・I〜IV は出さない）
  const tierTxt = p.rank.tier;
  let tfs = 44; g.font = "700 " + tfs + "px SG";
  while (tfs > 26 && g.measureText(tierTxt).width > box.x + box.w - 24 - tx) { tfs -= 2; g.font = "700 " + tfs + "px SG"; }
  g.fillStyle = "#FFFFFF"; g.fillText(tierTxt, tx, box.y + 90);
  // 下：日付と学校名
  g.fillStyle = "rgba(255,255,255,.75)"; g.font = "700 24px JP";
  g.fillText(md(day) + "（" + wd(day) + "）  クラウドハッシュテイル校", X, 572);
  // 右下：マスコット（chc-vc-bot/assets/rankup-mascot.png）
  const mascot = await loadImg(MASCOT);
  if (mascot) { const mh = 156, mw = mascot.width * mh / mascot.height; g.save(); g.shadowColor = "rgba(0,0,0,.35)"; g.shadowBlur = 14; g.drawImage(mascot, W - 48 - mw, H - 36 - mh, mw, mh); g.restore(); }
  return cv.encode("png");
}

/* 1回ぶん（1回の集計で上がった人たち）を投稿：1人につき1通・1枚 */
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
  const ch = await channelFor(client, !!force);   // 今すぐ投稿（テスト）は実験チャンネルへ
  const siteUrl = process.env.SITE_URL || "";
  /* 文字も Bot が出すとき（bot）：1通目に見出し、各人の画像に その人の明細、最後にしめの一言 */
  const vars = p => ({ emoji: emo(p.to) || EMOJI[p.to] || "🎉", fromEmoji: emo(p.from) || EMOJI[p.from] || "",
    name: p.name, from: p.from, to: p.to, division: p.division || "", lp: p.lp | 0,
    rankLabel: (emo(p.to) ? emo(p.to) + " " : "") + rankLabel({ tier: p.to, division: p.division, lp: p.lp }) });
  const head = withText ? fill(tpl.head, { count: sorted.length }).trim() : "";
  const foot = withText ? fill(tpl.foot, { count: sorted.length }).trim() : "";
  for (let i = 0; i < list.length; i++) {
    const png = await renderRankUp(list[i], icons, siteUrl, day);
    const line = withText ? fill(tpl.line, vars(sorted[i])).trim() : "";
    let content = [i === 0 ? head : "", line, i === list.length - 1 ? foot : ""].filter(Boolean).join("\n\n");
    if (run.dummy && i === 0) content = DUMMY_NOTE + content;
    await ch.send({ content: content || undefined, files: [{ attachment: png, name: "rankup-" + day + "-" + (i + 1) + ".png" }] });
  }
  return (withText ? "文字＋画像" : "画像") + "を1人ずつ投稿（" + list.length + "人）";
}

function startPromotePoster(client) {
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady() || !Canvas) return;
    busy = true;
    try {
      const doc = await fsGet("lboard_index/promote");
      if (!doc) return;
      const mode = ["both", "bot", "text"].indexOf(doc.imageMode) >= 0 ? doc.imageMode : "bot";   // 既定：文字＋画像を1人ずつ
      const runs = Object.entries(doc.runs || {}).filter(([, r]) => r && r.at).sort((a, b) => a[1].at - b[1].at);
      // 管理画面の「画像を今すぐ投稿」：いちばん新しい記録を出し直す（テスト用。一時停止は無視）
      if (doc.imgRequestAt && doc.imgRequestAt > (doc.imgHandledAt || 0)) {
        let res;
        const last = runs[runs.length - 1];
        try {
          if (doc.imgRequestDummy) {
            // ダミー：名簿からランダムに2人。1つ下のティアから上がったことにする
            const lp = await fsGet("lboard_index/lp");
            const rows = dummyPlayers(lp, 2, "promote" + Date.now()).map(x => {
              const ti = Math.max(1, TIERS.indexOf(x.rank.tier));
              return { id: x.id, name: x.name, from: TIERS[ti - 1], to: TIERS[ti], division: x.rank.division, lp: x.rank.lp };
            });
            res = await postRun(client, { at: Date.now(), day: new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10), rows, dummy: true }, true, true);   // ダミーは文面も付けて見た目を確認できるように
          } else res = last ? await postRun(client, last[1], mode === "bot", true) : "まだランクアップの記録がありません（「ダミーデータで投稿」なら試せます）";
        }
        catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/promote", [[["imgHandledAt"], Date.now()], [["imgLastResult"], (doc.imgRequestDummy ? "ダミーで投稿（実験チャンネル） → " : "今すぐ投稿（実験チャンネル） → ") + res]]);
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
