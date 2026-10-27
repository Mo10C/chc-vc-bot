/* =============================================================
   rising-poster.js — 毎日、急上昇プレイヤーの画像を Discord に投稿する

   index.js から startRisingPoster(client) で起動します。
   毎日 23:50（日本時間）に、その日 23:45 の LP 集計の結果から
     ① スタート地点（基準日）からの伸び ランキング
     ② その日 1日の伸び ランキング
   を画像にして「連絡事項」チャンネルへ投稿します（1通ずつ・画像つき）。

   ・文面は管理コンソール →「メッセージ」の
       「急上昇（スタートからの伸び）」「急上昇（1日の伸び）」で編集できます
       （lboard_index/messages の risingTotal / risingDaily）
   ・投稿のオン/オフ・人数・「今すぐ投稿」は管理コンソール →「メッセージ」の
     「📈 急上昇の画像投稿」で（lboard_index/rising）
   ・同じ日を2回投稿しないよう、投稿した日を lboard_index/rising.lastDay に記録します

   環境変数（Railway の Variables）
     DISCORD_SCHEDULE_CHANNEL_ID  投稿先（Cloudflare の Worker と同じ「連絡事項」のID）★必須
     SITE_URL                     サイトのURL（例 https://xxx.github.io/chc-lboard/）。
                                  ランクの紋章を「rank/…png」のようにサイト内のパスで設定している
                                  ときに使います（無ければ Bot に同梱の紋章を使います）
     RISING_AT                    投稿する時刻（既定 23:50。23:45 の集計より後にすること）
     FIREBASE_PROJECT_ID / FIREBASE_API_KEY   VC記録と共通
   ============================================================= */
"use strict";

const path = require("path");
const fs = require("fs");

let Canvas = null;
try { Canvas = require("@napi-rs/canvas"); } catch (e) { }

const JST = 9 * 60 * 60 * 1000;
const AT = /^\d{1,2}:\d{2}$/.test(process.env.RISING_AT || "") ? process.env.RISING_AT : "23:50";
const RANK_DIR = path.join(__dirname, "rank");
const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER"];
const DIVS = ["IV", "III", "II", "I"];
const APEX = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

/* ---------------- 日付 ---------------- */
const jstNow = () => new Date(Date.now() + JST);
const dayKey = ms => new Date(ms + JST).toISOString().slice(0, 10);
const shiftDay = (k, n) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) + n * 86400000).toISOString().slice(0, 10);
const md = k => Number(k.slice(5, 7)) + "/" + Number(k.slice(8, 10));
const wd = k => "日月火水木金土"[new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10))).getUTCDay()];

/* ---------------- ランク（core.js の rankOfAbs と同じ） ---------------- */
function rankOfAbs(abs) {
  abs = Math.round(abs);
  if (abs >= 2800) return { tier: "MASTER", division: "", lp: abs - 2800 };
  const ti = Math.max(0, Math.floor(abs / 400)), di = Math.floor((abs % 400) / 100);
  return { tier: TIERS[Math.min(ti, 6)], division: DIVS[di] || "IV", lp: abs % 100 };
}
const rankLabel = r => r ? (r.tier + (r.division && !APEX.has(r.tier) ? " " + r.division : "") + " " + (r.lp | 0) + "LP") : "";

/* ---------------- Firestore（REST） ---------------- */
const fsReady = () => !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY);
const fsBase = () => "https://firestore.googleapis.com/v1/projects/" + process.env.FIREBASE_PROJECT_ID + "/databases/(default)/documents";
function enc(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(enc) } };
  if (typeof x === "object") { const f = {}; Object.entries(x).forEach(([k, v]) => { f[k] = enc(v); }); return { mapValue: { fields: f } }; }
  return { stringValue: String(x) };
}
function dec(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) { const o = {}; Object.entries(v.mapValue.fields || {}).forEach(([k, x]) => { o[k] = dec(x); }); return o; }
  return null;
}
async function fsGet(doc) {
  const r = await fetch(fsBase() + "/" + doc + "?key=" + process.env.FIREBASE_API_KEY);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore読み込み失敗 " + r.status);
  const j = await r.json();
  return dec({ mapValue: { fields: j.fields || {} } });
}
async function fsPatch(doc, obj) {
  const fields = {}; Object.entries(obj).forEach(([k, v]) => { fields[k] = enc(v); });
  const q = Object.keys(obj).map(p => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const r = await fetch(fsBase() + "/" + doc + "?key=" + process.env.FIREBASE_API_KEY + "&" + q, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
}

/* ---------------- 文面（core.js の既定と同じ） ---------------- */
const DEFAULT_MSG = {
  risingTotal: { head: "📈 **急上昇プレイヤー**　スタート（{base}）から {md} までの伸び", line: "{medal} **{name}**　**+{gain}LP**　{rankLabel}", foot: "この調子で、みんなでランクを上げていこう！" },
  risingDaily: { head: "🔥 **{md}（{wd}）の1日の伸び**", line: "{medal} **{name}**　**+{gain}LP**　{rankLabel}", foot: "" }
};
const fill = (tpl, v) => String(tpl == null ? "" : tpl).replace(/\{(\w+)\}/g, (m, k) => (v && v[k] != null) ? String(v[k]) : "");
function buildMessage(tpl, head, rows) {
  const h = fill(tpl.head, head).trim(), f = fill(tpl.foot, head).trim();
  const body = rows.map(r => fill(tpl.line, r)).join("\n");
  return ((h ? h + "\n" : "") + body + (f ? "\n\n" + f : "")).trim();
}
const MEDAL_TXT = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/* ---------------- ランキングを作る ----------------
   day … 集計した日（前日）。その日までの記録だけを使う。
   total：最新（day 以前で最後の記録）− 基準日（基準日以前で最後の記録。無ければ最初の記録）
   daily：day の記録 − その前の記録（day に記録がある人だけ） */
function ranking(lp, day, kind) {
  const base = lp.baseline || lp.collectFrom || "";
  const out = [];
  Object.entries(lp.members || {}).forEach(([id, m]) => {
    const h = (lp.hist || {})[id] || {};
    const keys = Object.keys(h).filter(k => k <= day).sort();
    if (keys.length < 2) return;
    const last = keys[keys.length - 1];
    let gain = null;
    if (kind === "total") {
      const le = base ? keys.filter(k => k <= base) : [];
      const bk = le.length ? le[le.length - 1] : keys[0];
      if (bk !== last) gain = h[last] - h[bk];
    } else if (last === day) {
      gain = h[day] - h[keys[keys.length - 2]];
    }
    if (gain == null || gain <= 0) return;
    const rank = m.tier ? { tier: m.tier, division: m.division || "", lp: m.lp | 0 } : rankOfAbs(h[last]);
    out.push({ id, name: m.name || "—", avatar: m.avatar || "", gain, rank });
  });
  out.sort((a, b) => b.gain - a.gain || a.name.localeCompare(b.name, "ja"));
  return { list: out, base };
}

/* ---------------- 画像 ---------------- */
let fontsReady = false;
function setupFonts() {
  if (fontsReady || !Canvas) return;
  const reg = (pkg, file, alias) => {
    try { Canvas.GlobalFonts.registerFromPath(require.resolve(pkg + "/" + file), alias); } catch (e) { console.warn("[rising] フォントを読めませんでした " + file, e.message); }
  };
  reg("@expo-google-fonts/noto-sans-jp", "700Bold/NotoSansJP_700Bold.ttf", "JP");
  reg("@expo-google-fonts/noto-sans-jp", "900Black/NotoSansJP_900Black.ttf", "JPB");
  reg("@expo-google-fonts/space-grotesk", "700Bold/SpaceGrotesk_700Bold.ttf", "SG");
  fontsReady = true;
}
// 絵文字など、フォントに無い文字は描けないので外す
const clean = s => String(s || "").replace(/[\p{Extended_Pictographic}‍️⃣]/gu, "").trim() || "—";

async function loadImg(src, siteUrl) {
  if (!src) return null;
  try {
    if (/^data:image\//.test(src)) return await Canvas.loadImage(Buffer.from(src.split(",")[1], "base64"));
    let url = src;
    if (!/^https?:\/\//.test(src)) {
      // サイト内の相対パス（rank/xxx.png）：同梱の紋章 → サイトのURL の順で探す
      const local = path.join(__dirname, src.replace(/^\.?\//, ""));
      if (src.startsWith("rank/") && fs.existsSync(local)) return await Canvas.loadImage(local);
      if (!siteUrl) return null;
      url = siteUrl.replace(/\/?$/, "/") + src.replace(/^\.?\//, "");
    }
    for (let i = 0; i < 2; i++) {            // 通信が一瞬失敗しても、もう1回だけ試す
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;              // 404 など（古いアイコンのURL）は次の候補へ
        return await Canvas.loadImage(Buffer.from(await r.arrayBuffer()));
      } catch (e) { if (i) return null; }
    }
    return null;
  } catch (e) { return null; }
}
/* Discord から、いまのアイコンのURLを取り直す（サーバー用アイコン → 本人のアイコン の順）。
   記録に残っているURLは、本人がアイコンを変えると読めなくなるため。 */
async function liveAvatars(client, ids) {
  const out = {};
  const guilds = [...client.guilds.cache.values()];
  for (const id of ids) {
    const uid = String(id).replace(/^u_/, "");
    if (!/^\d+$/.test(uid)) continue;
    for (const g of guilds) {
      try {
        const m = await g.members.fetch(uid);
        if (m) { out[id] = m.displayAvatarURL({ extension: "png", forceStatic: true, size: 256 }); break; }
      } catch (e) { }
    }
    if (!out[id]) {
      try { const u = await client.users.fetch(uid); out[id] = u.displayAvatarURL({ extension: "png", forceStatic: true, size: 256 }); } catch (e) { }
    }
  }
  return out;
}
async function rankImg(tier, icons, siteUrl, cache) {
  if (cache[tier] !== undefined) return cache[tier];
  const set = ((icons || {}).tiers || {})[tier] || {};
  let im = set.img ? await loadImg(set.img, siteUrl) : null;
  if (!im) {
    const f = path.join(RANK_DIR, "TFT_Regalia_" + tier.charAt(0) + tier.slice(1).toLowerCase() + ".png");
    if (fs.existsSync(f)) try { im = await Canvas.loadImage(f); } catch (e) { }
  }
  cache[tier] = im;
  return im;
}

function rr(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function fitText(g, t, maxW) {
  if (g.measureText(t).width <= maxW) return t;
  while (t.length > 1 && g.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t + "…";
}
function star(g, cx, cy, r, color) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 - Math.PI / 2, rad = i % 2 ? r * 0.32 : r;
    g.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
  }
  g.closePath(); g.fillStyle = color; g.fill();
}
function medal(g, i, cx, cy) {
  if (i >= 3) {   // 4位以下はキラキラ
    star(g, cx + 4, cy + 2, 26, "#F4C542"); star(g, cx - 16, cy - 16, 11, "#F7D774"); star(g, cx - 14, cy + 20, 8, "#F7D774");
    return;
  }
  const C = [["#F7D774", "#E0A93A", "#8A5A00"], ["#E6E9EE", "#AEB4BD", "#5B6470"], ["#E9A36B", "#B86A2E", "#6B3610"]][i];
  // リボン
  g.fillStyle = "#3C5BD6"; g.beginPath(); g.moveTo(cx - 16, cy - 40); g.lineTo(cx - 4, cy - 40); g.lineTo(cx + 4, cy - 14); g.lineTo(cx - 8, cy - 14); g.closePath(); g.fill();
  g.fillStyle = "#E14B4B"; g.beginPath(); g.moveTo(cx + 16, cy - 40); g.lineTo(cx + 4, cy - 40); g.lineTo(cx - 4, cy - 14); g.lineTo(cx + 8, cy - 14); g.closePath(); g.fill();
  const gr = g.createLinearGradient(cx - 22, cy - 22, cx + 22, cy + 22);
  gr.addColorStop(0, C[0]); gr.addColorStop(1, C[1]);
  g.beginPath(); g.arc(cx, cy + 6, 23, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
  g.lineWidth = 2; g.strokeStyle = "rgba(255,255,255,.7)"; g.stroke();
  g.fillStyle = C[2]; g.font = "700 26px SG"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(String(i + 1), cx, cy + 7);
}
async function drawAvatar(g, url, name, cx, cy, r) {
  let im = null;
  for (const u of (Array.isArray(url) ? url : [url])) { if (u && (im = await loadImg(u))) break; }
  g.save();
  g.beginPath(); g.arc(cx, cy, r + 4, 0, Math.PI * 2); g.fillStyle = "#C9DCEB"; g.fill();
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath(); g.clip();
  if (im) g.drawImage(im, cx - r, cy - r, r * 2, r * 2);
  else {
    const gr = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r); gr.addColorStop(0, "#5AB8FF"); gr.addColorStop(1, "#3F7FF0");
    g.fillStyle = gr; g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.fillStyle = "#fff"; g.font = "900 " + Math.round(r * 0.9) + "px JPB"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(clean(name).slice(0, 1), cx, cy + 2);
  }
  g.restore();
}

/* 画像を作る：title / sub / list（{name, avatar, gain, rank}） */
async function renderCard({ title, sub, list, icons, siteUrl }) {
  setupFonts();
  const W = 1080, PAD = 54, ROW = 160, GAP = 22, TOP = 210;
  const H = TOP + list.length * ROW + (list.length - 1) * GAP + PAD + 10;
  const cv = Canvas.createCanvas(W, H), g = cv.getContext("2d");
  // 背景（サイトの水色）＋クリーム色のカード
  g.fillStyle = "#DCEAF6"; g.fillRect(0, 0, W, H);
  const bg = g.createLinearGradient(0, 0, W * 0.4, H);
  bg.addColorStop(0, "#FBF3E4"); bg.addColorStop(0.55, "#FFFFFF"); bg.addColorStop(1, "#FFFFFF");
  rr(g, 18, 18, W - 36, H - 36, 46); g.fillStyle = bg; g.fill();
  g.lineWidth = 4; g.strokeStyle = "#E3CF9E"; g.stroke();

  // 見出し（🎉の代わりに、紙ふぶきの飾り）
  const conf = [["#F4C542", 70, 92, 9], ["#E14B4B", 98, 70, 7], ["#3C5BD6", 112, 104, 6], ["#2FC48D", 84, 118, 6]];
  conf.forEach(([c, x, y, r]) => { g.beginPath(); g.arc(x + 14, y + 6, r, 0, Math.PI * 2); g.fillStyle = c; g.fill(); });
  star(g, 104, 92, 18, "#F4C542");
  g.fillStyle = "#1F2F45"; g.textAlign = "left"; g.textBaseline = "alphabetic";
  g.font = "900 52px JPB"; g.fillText(title, 150, 118);
  g.fillStyle = "#6F7F8F"; g.font = "700 28px JP"; g.fillText(sub, 82, 172);

  const cache = {};
  for (let i = 0; i < list.length; i++) {
    const x = list[i], y = TOP + i * (ROW + GAP), cx0 = PAD + 20, w = W - (PAD + 20) * 2;
    rr(g, cx0, y, w, ROW, 40); g.fillStyle = "#FFFFFF"; g.fill();
    g.lineWidth = 3; g.strokeStyle = i < 3 ? "#E6D2A0" : "#EADFC4"; g.stroke();
    medal(g, i, cx0 + 82, y + ROW / 2);
    await drawAvatar(g, [x.live, x.avatar], x.name, cx0 + 205, y + ROW / 2, 47);   // Discordの今のアイコン → 記録のアイコン
    // 名前
    const nx = cx0 + 290;
    g.textAlign = "left"; g.textBaseline = "alphabetic"; g.fillStyle = "#1F2F45";
    g.font = "900 40px JPB";
    g.fillText(fitText(g, clean(x.name), w - 290 - 260), nx, y + 70);
    // ランク（紋章＋文字）
    const im = await rankImg(x.rank.tier, icons, siteUrl, cache);
    let tx = nx;
    if (im) { const ih = 44, iw = Math.min(ih * 1.6, im.width * ih / im.height); g.drawImage(im, nx, y + 88, iw, ih); tx = nx + iw + 12; }
    g.fillStyle = "#7A8794"; g.font = "700 28px SG";
    g.fillText(rankLabel(x.rank), tx, y + 122);
    // 伸び
    g.textAlign = "right"; g.fillStyle = "#5E9E3A"; g.font = "700 50px SG";
    g.fillText("+" + x.gain + "LP", cx0 + w - 42, y + ROW / 2 + 18);
  }
  return cv.encode("png");
}

/* ---------------- 投稿 ---------------- */
async function postDay(client, day, opts) {
  opts = opts || {};
  if (!Canvas) throw new Error("@napi-rs/canvas が入っていません（package.json を更新して再デプロイしてください）");
  const chId = process.env.DISCORD_SCHEDULE_CHANNEL_ID;
  if (!chId) throw new Error("DISCORD_SCHEDULE_CHANNEL_ID が未設定です（Railway の Variables に、連絡事項チャンネルのIDを入れてください）");
  const [lp, msgs, icons, cfg] = await Promise.all([fsGet("lboard_index/lp"), fsGet("lboard_index/messages"), fsGet("lboard_index/rankicons"), fsGet("lboard_index/rising")]);
  if (!lp) throw new Error("LPの記録がありません");
  const c = Object.assign({ total: true, daily: true, top: 6 }, cfg || {});
  const top = Math.max(1, Math.min(10, c.top | 0 || 6));
  const ch = await client.channels.fetch(chId);
  const tierEmoji = t => ((((icons || {}).tiers || {})[t] || {}).emoji || "");
  const sent = [];
  for (const kind of ["total", "daily"]) {
    if (!c[kind]) continue;
    const key = kind === "total" ? "risingTotal" : "risingDaily";
    const tpl = Object.assign({}, DEFAULT_MSG[key], (msgs || {})[key] || {});
    if (!opts.force && tpl.pause && day <= tpl.pause) { sent.push(kind + ":一時停止中"); continue; }
    const { list, base } = ranking(lp, day, kind);
    if (!list.length) { sent.push(kind + ":伸びた人なし"); continue; }
    const L = list.slice(0, top);
    const live = await liveAvatars(client, L.map(x => x.id));
    L.forEach(x => { x.live = live[x.id] || ""; });
    const png = await renderCard({
      title: kind === "total" ? "急上昇プレイヤー" : "今日の急上昇",
      sub: kind === "total" ? "スタート（" + (base ? md(base) : "最初の記録") + "）から " + md(day) + " までの伸び" : md(day) + "（" + wd(day) + "）1日の伸び",
      list: L, icons, siteUrl: process.env.SITE_URL || ""
    });
    const head = { md: md(day), wd: wd(day), date: day, base: base ? md(base) : "", n: L.length };
    const rows = L.slice(0, 3).map((x, i) => ({ medal: MEDAL_TXT[i], rank: i + 1, name: x.name, gain: x.gain,
      rankLabel: (tierEmoji(x.rank.tier) ? tierEmoji(x.rank.tier) + " " : "") + rankLabel(x.rank) }));
    await ch.send({ content: buildMessage(tpl, head, rows), files: [{ attachment: png, name: "rising-" + kind + "-" + day + ".png" }] });
    sent.push(kind + ":" + L.length + "人");
  }
  return sent;
}

/* ---------------- 起動 ---------------- */
function startRisingPoster(client) {
  if (!Canvas) console.warn("[rising] @napi-rs/canvas が無いので、急上昇の画像投稿は動きません");
  let busy = false, started = false;
  const tick = async () => {
    if (busy || !started || !fsReady()) return;
    busy = true;
    try {
      const cfg = (await fsGet("lboard_index/rising")) || {};
      const now = jstNow(), hm = now.toISOString().slice(11, 16), today = now.toISOString().slice(0, 10);
      const yday = shiftDay(today, -1);
      /* 投稿する日：23:50 を過ぎたら「きょう」。0:00〜12:00 は、きのうの分を出せていなければその取りこぼし。 */
      const day = hm >= AT ? today : yday;
      // 管理画面の「今すぐ投稿」（テスト用。一時停止は無視、同じ日でも投稿する）
      if (cfg.requestAt && cfg.requestAt > (cfg.handledAt || 0)) {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(cfg.requestDay || "") ? cfg.requestDay : day;
        let res, err = "";
        try { res = await postDay(client, d, { force: true }); } catch (e) { err = e.message; }
        const patch = { handledAt: Date.now(), lastResult: err ? "失敗：" + err : "今すぐ投稿 " + d + " → " + res.join(" / ") };
        if (!err && d === day && (hm >= AT || hm < "12:00")) { patch.lastDay = day; patch.lastAt = Date.now(); cfg.lastDay = day; }   // 同じ日を毎日投稿でもう一度出さない
        await fsPatch("lboard_index/rising", patch);
        console.log("[rising] 今すぐ投稿: " + (err || res.join(" / ")));
      }
      // 毎日の投稿（23:50〜翌12:00 の間に1回。その日の集計が終わっていなければ、翌 2:00 まで待つ）
      if (cfg.enabled === false || (hm < AT && hm >= "12:00") || cfg.lastDay === day) return;
      if (day === yday && cfg.lastDay && cfg.lastDay > yday) return;
      const lp = await fsGet("lboard_index/lp");
      if (lp && lp.lastCollect && lp.lastCollect < day && (day === today || hm < "02:00")) return;
      let res, err = "";
      try { res = await postDay(client, day); } catch (e) { err = e.message; }
      await fsPatch("lboard_index/rising", { lastDay: day, lastAt: Date.now(), lastResult: err ? "失敗：" + err : day + " → " + res.join(" / ") });
      console.log("[rising] " + day + " の投稿: " + (err || res.join(" / ")));
    } catch (e) { console.error("[rising]", e.message); }
    finally { busy = false; }
  };
  const onReady = () => { if (started) return; started = true; setTimeout(tick, 5000); };
  client.once("clientReady", onReady);
  client.once("ready", onReady);
  const t = setInterval(tick, 60 * 1000);
  t.unref && t.unref();
}

module.exports = { startRisingPoster, ranking, renderCard, _rankLabel: rankLabel };
