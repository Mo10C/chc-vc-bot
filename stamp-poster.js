/* =============================================================
   stamp-poster.js — スタンプカードをコンプリートした人を Discord でお祝いする

   index.js から startStampPoster(client) で起動します。
   スタンプは生徒がサイト（stamp.html）で押し、そろったら lboard_index/stamps の
   users.<id>.completeAt にサイトが時刻を書きます。この Bot はそれを見つけたら連絡事項へ投稿し、
   users.<id>.postedAt を書きます（同じ人を2回お祝いしないため）。

   lboard_index/stamp（管理コンソール →「スタンプ」）
     post.enabled      … オフなら何も投稿しない
     post.fullEnabled  … ぜんぶうめたときに投稿する（既定オン）
     post.full         … その文面。{name} {mention} {count} {total} {lines} {title} が置きかわる
                         サイトが users.<id>.fullAt を書き、Bot が fullPostedAt を書く
     post.bingoEnabled … ①ビンゴした人のお祝い（既定オン）。文面は post.complete
     testKind          … テスト投稿のパターン（both＝①②を続けて（既定）／bingo＝①だけ／full＝②だけ）
     post.image        … ランクアップのようなお祝い画像をつける（既定オン）
   ・画像の右下のマスコットは assets/rankup-mascot.png、押してあるハンコは assets/stamp.png
     testRequestAt … 「🧪 実験チャンネルにテスト投稿」。testHandledAt / testLastResult を Bot が書く
   ・コンプリートから3日以上たった分は、あとから投稿しません（Bot が止まっていたときなど）
   ============================================================= */
"use strict";

const { shared } = require("./rising-poster");
const { Canvas, enc, channelFor, fsGet, fsReady, DUMMY_NOTE, liveAvatars, setupFonts, loadImg, rr, star, clean, fitText, md, wd } = shared;

const LATE_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_TEXT = "🎉 **{name}** さんが「{title}」で **ビンゴ**しました！\nおめでとうございます！ まだの人も、いっしょに遊ぼう 🎮";
const OLD_TEXT = "🎉 **{name}** さんが「{title}」で **ビンゴ！**（{lines}ライン・{count}マス）\nおめでとうございます！ まだの人も、いっしょに遊ぼう 🎮";
const OLD_TEXTS = [OLD_TEXT, "🎉 **{name}** さんが「{title}」のスタンプカードを **コンプリート**！（{count} / {total}マス）\nおめでとうございます！ まだの人も、いっしょに遊ぼう 🎮"];   // 前の既定の文面（新しい文面に置きかえる）
const DEFAULT_FULL = "🏆 **{name}** さんが「{title}」のカードを **ぜんぶうめました**！\nすごい！ おめでとうございます 🎊";
const OLD_FULL = "🏆 **{name}** さんが「{title}」のカードを **ぜんぶうめました**！（{count}マス・{lines}ライン）\nすごい！ おめでとうございます 🎊";

// マス目とそろったライン（core.js の stampGrid / stampLines と同じ数え方。24マス＋FREE なら真ん中が FREE）
function gridOf(cfg, stamps) {
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
  return { cols, rows, cells, has, lines: L.filter(a => a.every(has)) };
}
const linesOf = (cfg, stamps) => gridOf(cfg, stamps).lines.length;
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
  const pf = cfg.post && cfg.post.full;
  const tx = kind === "full" ? ((pf && pf !== OLD_FULL) ? pf : DEFAULT_FULL) : (((cfg.post && cfg.post.complete) && !OLD_TEXTS.includes(cfg.post.complete)) ? cfg.post.complete : DEFAULT_TEXT);
  return fill(tx, {
    name: u.name || "—", mention: discordId ? "<@" + discordId + ">" : (u.name || "—"),
    count, total: need, lines: linesOf(cfg, u.stamps), title: cfg.title || "スタンプカード" });
}

/* ---------------- お祝い画像（1200×675・ランクアップと同じ雰囲気） ---------------- */
function rng(seed) { let x = 0; for (const ch of String(seed)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
async function renderStamp(cfg, id, u, kind, avatarUrl) {
  setupFonts();
  const W = 1200, H = 675, cv = Canvas.createCanvas(W, H), g = cv.getContext("2d"), R = rng(id + kind);
  const PINK = "#FF6FA8", GOLD = "#F2B53C", LEAF = "#7DBE3C", INK = "#2E4A17", SUB = "#5E8A2C";   // ハッシュテイル校の色：淡い黄緑
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#FBFFF0"); bg.addColorStop(0.55, "#EAF7CF"); bg.addColorStop(1, "#CFEBA2");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const cx = 280, cy = 300;
  g.save(); g.translate(cx, cy);
  for (let i = 0; i < 12; i++) {
    g.rotate(Math.PI * 2 / 12);
    const lg = g.createLinearGradient(0, 0, 480, 0); lg.addColorStop(0, "rgba(255,255,255,.75)"); lg.addColorStop(1, "rgba(255,255,255,0)");
    g.beginPath(); g.moveTo(0, 0); g.lineTo(480, -34); g.lineTo(480, 34); g.closePath(); g.fillStyle = lg; g.fill();
  }
  g.restore();
  const glow = g.createRadialGradient(cx, cy, 60, cx, cy, 300); glow.addColorStop(0, "rgba(255,246,190,.85)"); glow.addColorStop(1, "rgba(255,246,190,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  const CONF = [GOLD, PINK, "#5BC8FF", LEAF, "#FFB13D", "#9ED36A"];
  for (let i = 0; i < 30; i++) {
    const x = 40 + R() * (W - 80), y = R() < 0.5 ? 40 + R() * 50 : H - 90 + R() * 50, w = 6 + R() * 8, h = 3 + R() * 4;
    g.save(); g.translate(x, y); g.rotate(R() * Math.PI); g.globalAlpha = 0.45 + R() * 0.35;
    g.fillStyle = CONF[(R() * CONF.length) | 0]; g.fillRect(-w / 2, -h / 2, w, h); g.restore();
  }
  [[470, 100, 12], [1110, 120, 9], [90, 600, 8]].forEach(([x, y, r]) => star(g, x, y, r, "rgba(242,181,60,.8)"));
  g.lineWidth = 6; g.strokeStyle = LEAF; rr(g, 18, 18, W - 36, H - 36, 28); g.stroke();
  g.lineWidth = 2; g.strokeStyle = "rgba(125,190,60,.45)"; rr(g, 32, 32, W - 64, H - 64, 20); g.stroke();

  // 左：アイコン（光る輪）＋右下にハンコ
  const r = 140;
  g.save(); g.shadowColor = "rgba(125,190,60,.6)"; g.shadowBlur = 40;
  g.beginPath(); g.arc(cx, cy, r + 14, 0, Math.PI * 2);
  const ring = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r); ring.addColorStop(0, "#FFF1B8"); ring.addColorStop(0.5, GOLD); ring.addColorStop(1, LEAF);
  g.fillStyle = ring; g.fill(); g.restore();
  let im = null;
  for (const src of [avatarUrl, u.avatar]) { if (src && (im = await loadImg(src))) break; }
  g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
  if (im) g.drawImage(im, cx - r, cy - r, r * 2, r * 2);
  else { g.fillStyle = LEAF; g.fillRect(cx - r, cy - r, r * 2, r * 2); g.fillStyle = "#fff"; g.font = "900 130px JPB"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(clean(u.name).slice(0, 1), cx, cy + 6); }
  g.restore();
  const stampIm = await loadImg("assets/stamp.png");
  if (stampIm) {
    g.save(); g.translate(cx + 112, cy + 110); g.rotate(-0.25);
    g.beginPath(); g.arc(0, 0, 76, 0, Math.PI * 2); g.fillStyle = "#FFFFFF"; g.shadowColor = "rgba(46,74,23,.3)"; g.shadowBlur = 14; g.fill(); g.shadowBlur = 0;
    g.drawImage(stampIm, -80, -80, 160, 160); g.restore();
  }

  // 右：イベント名 → 大見出し → 名前 → ひとこと帯 → 押したカード
  const X = 515, day = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  // イベント名（緑のふだ）
  g.font = "900 24px JPB";
  const ev = fitText(g, clean(cfg.title || "スタンプカード"), W - X - 120), evw = g.measureText(ev).width + 44;
  rr(g, X, 62, evw, 44, 22); g.fillStyle = LEAF; g.fill();
  g.fillStyle = "#FFFFFF"; g.fillText(ev, X + 22, 93);
  // 大見出し
  const big = kind === "full" ? "COMPLETE!" : "BINGO!";
  const tg = g.createLinearGradient(X, 110, X, 220); tg.addColorStop(0, "#FFE27A"); tg.addColorStop(0.5, "#FFB627"); tg.addColorStop(1, "#F07F1A");
  let bfs = 116; g.font = "700 " + bfs + "px SG";
  while (bfs > 70 && g.measureText(big).width > W - X - 60) { bfs -= 4; g.font = "700 " + bfs + "px SG"; }
  g.lineJoin = "round"; g.lineWidth = 14; g.strokeStyle = INK; g.strokeText(big, X - 4, 214); g.fillStyle = tg; g.fillText(big, X - 4, 214);
  // 名前
  g.fillStyle = INK; let fs = 56; g.font = "900 " + fs + "px JPB";
  while (fs > 30 && g.measureText(clean(u.name) + " さん").width > W - X - 70) { fs -= 2; g.font = "900 " + fs + "px JPB"; }
  const nm = fitText(g, clean(u.name), W - X - 70 - g.measureText(" さん").width);
  g.fillText(nm, X, 296);
  const nw = g.measureText(nm).width;
  g.font = "900 " + Math.round(fs * 0.55) + "px JPB"; g.fillStyle = SUB; g.fillText(" さん", X + nw, 296);
  // ひとこと帯（リボン）
  const msg = kind === "full" ? "スタンプカードをぜんぶうめました！" : "ビンゴたっせい！";
  g.font = "900 28px JPB"; const mw0 = g.measureText(msg).width + 56, ry = 322;
  g.fillStyle = "#E88A16";
  g.beginPath(); g.moveTo(X - 12, ry + 8); g.lineTo(X + 14, ry + 8); g.lineTo(X + 14, ry + 58); g.lineTo(X - 12, ry + 58); g.lineTo(X + 2, ry + 33); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(X + mw0 + 12, ry + 8); g.lineTo(X + mw0 - 14, ry + 8); g.lineTo(X + mw0 - 14, ry + 58); g.lineTo(X + mw0 + 12, ry + 58); g.lineTo(X + mw0 - 2, ry + 33); g.closePath(); g.fill();
  rr(g, X, ry, mw0, 54, 10); g.fillStyle = "#FFB627"; g.fill();
  g.fillStyle = INK; g.fillText(msg, X + 28, ry + 37);

  // 押したカード（少しかたむけた白いカード。ビンゴのラインには金の線）
  const G = gridOf(cfg, u.stamps), hit = new Set([].concat(...G.lines));
  const n = Math.max(G.cols, G.rows), CS = 214, pad = 14, gap = n >= 5 ? 5 : 8, cs = (CS - pad * 2 - gap * (n - 1)) / n;
  const ccx = X + 10 + CS / 2, ccy = 412 + CS / 2;
  g.save(); g.translate(ccx, ccy); g.rotate(-0.06);
  g.shadowColor = "rgba(46,74,23,.28)"; g.shadowBlur = 22; g.shadowOffsetY = 8;
  rr(g, -CS / 2, -CS / 2, CS, CS, 22); g.fillStyle = "#FFFFFF"; g.fill();
  g.shadowColor = "transparent"; g.lineWidth = 3; g.strokeStyle = LEAF; g.stroke();
  const ox = -CS / 2 + pad, oy = -CS / 2 + pad, at = i => [ox + (i % G.cols) * (cs + gap), oy + Math.floor(i / G.cols) * (cs + gap)];
  G.cells.forEach((c, i) => {
    const [x, y] = at(i);
    rr(g, x, y, cs, cs, Math.max(4, cs * 0.2));
    g.fillStyle = c === "__free" ? "#FFF3C4" : "#F3F8E8"; g.fill();
    g.lineWidth = 1.5; g.strokeStyle = c === "__free" ? GOLD : "rgba(125,190,60,.5)"; g.stroke();
    if (c === "__free") { g.fillStyle = "#C78A00"; g.font = "700 " + Math.round(cs * 0.3) + "px SG"; g.textAlign = "center"; g.fillText("FREE", x + cs / 2, y + cs * 0.62); g.textAlign = "left"; }
    else if (u.stamps && u.stamps[c] && stampIm) { g.save(); g.translate(x + cs / 2, y + cs / 2); g.rotate(-0.24 + ((i * 37) % 7) * 0.05); g.drawImage(stampIm, -cs * 0.56, -cs * 0.56, cs * 1.12, cs * 1.12); g.restore(); }
  });
  if (kind !== "full") {
    g.lineCap = "round"; g.lineWidth = Math.max(6, cs * 0.22); g.strokeStyle = "rgba(255,182,39,.8)";
    G.lines.forEach(L => { const [x1, y1] = at(L[0]), [x2, y2] = at(L[L.length - 1]);
      g.beginPath(); g.moveTo(x1 + cs / 2, y1 + cs / 2); g.lineTo(x2 + cs / 2, y2 + cs / 2); g.stroke(); });
  }
  g.restore();
  // ふきだし（マスコットから）
  const bx = X + CS + 52, by = 470, btx = "おめでとう！";
  g.font = "900 30px JPB"; const bw = g.measureText(btx).width + 44;
  g.save(); g.translate(bx, by); g.rotate(-0.05);
  g.shadowColor = "rgba(46,74,23,.2)"; g.shadowBlur = 10; g.shadowOffsetY = 4;
  rr(g, 0, 0, bw, 60, 30); g.fillStyle = "#FFFFFF"; g.fill();
  g.beginPath(); g.moveTo(bw - 70, 56); g.lineTo(bw - 40, 56); g.lineTo(bw - 34, 82); g.closePath(); g.fill();
  g.shadowColor = "transparent"; g.fillStyle = "#E2477E"; g.fillText(btx, 22, 41);
  g.restore();
  // 左下：日付と学校名（アイコンの下）
  g.textAlign = "center"; g.fillStyle = SUB; g.font = "700 22px JP";
  g.fillText(md(day) + "（" + wd(day) + "）  クラウドハッシュテイル校", cx, 610);
  g.textAlign = "left";
  const mascot = await loadImg("assets/rankup-mascot.png");
  if (mascot) { const mh = 150, mw = mascot.width * mh / mascot.height; g.save(); g.shadowColor = "rgba(46,74,23,.3)"; g.shadowBlur = 14; g.drawImage(mascot, W - 48 - mw, H - 36 - mh, mw, mh); g.restore(); }
  return cv.encode("png");
}
// 文面（＋画像）を1通で送る
async function sendCelebration(client, ch, cfg, id, u, kind, note, mentions) {
  const content = (note || "") + textFor(cfg, id, u, kind);
  const msg = { content, allowedMentions: { parse: mentions ? ["users"] : [] } };
  if (Canvas && (!cfg.post || cfg.post.image !== false)) {
    try {
      const live = await liveAvatars(client, [id]);
      msg.files = [{ attachment: await renderStamp(cfg, id, u, kind, live[id] || ""), name: "stamp-" + kind + ".png" }];
    } catch (e) { console.error("[stamp] 画像を作れませんでした（文字だけ投稿します）", e.message); }
  }
  await ch.send(msg);
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
          // テストに使う人：いちばんスタンプの多い人（だれもいなければ「テスト生徒」）
          const ent = Object.entries(rec.users || {}).sort((a, b) => Object.keys((b[1] || {}).stamps || {}).length - Object.keys((a[1] || {}).stamps || {}).length)[0];
          const [id, u] = ent || ["u_0", { name: "テスト生徒", stamps: {} }];
          // テスト：①ビンゴ（いちばん上の段だけそろえる）→ ②コンプリート（ぜんぶ）を続けて投稿
          const kinds = cfg.testKind === "bingo" ? ["complete"] : cfg.testKind === "full" ? ["full"] : ["complete", "full"];
          const now0 = Date.now(), allStamps = {}, rowStamps = {};
          (cfg.tasks || []).forEach(t => { allStamps[t.id] = { at: now0 }; });
          const G = gridOf(cfg, allStamps);
          (G.lines[0] || []).map(i => G.cells[i]).filter(c => c !== "__free").forEach(t => { rowStamps[t] = { at: now0 }; });
          const ch = await channelFor(client, true);
          const done = [];
          for (const k of kinds) {
            const uu = Object.assign({}, u, { stamps: k === "full" ? allStamps : rowStamps });
            await sendCelebration(client, ch, cfg, id, uu, k, DUMMY_NOTE, false);
            done.push(k === "full" ? "②コンプリート" : "①ビンゴ");
          }
          res = done.join("・") + "を投稿しました";
        } catch (e) { res = "失敗：" + e.message; }
        await fsSet("lboard_index/stamp", [[["testHandledAt"], Date.now()], [["testLastResult"], "テスト → " + res]]);
        console.log("[stamp] テスト投稿: " + res);
      }
      if (cfg.post && cfg.post.enabled === false) return;
      const rec = await fsGet("lboard_index/stamps");
      const now = Date.now();
      const fullOn = !cfg.post || cfg.post.fullEnabled !== false;
      const bingoOn = !cfg.post || cfg.post.bingoEnabled !== false;   // ①ビンゴした人（既定オン）
      for (const [id, u] of Object.entries((rec && rec.users) || {})) {
        if (!u) continue;
        // [達成の時刻, 投稿済みの印, 種類]
        const jobs = (bingoOn ? [["completeAt", "postedAt", "complete"]] : []).concat(fullOn ? [["fullAt", "fullPostedAt", "full"]] : []);
        for (const [atK, doneK, kind] of jobs) {
          if (!u[atK] || u[doneK]) continue;
          // 達成と「ぜんぶうめた」が同時なら、ぜんぶうめたほうだけ投稿する
          if (kind === "complete" && fullOn && u.fullAt && !u.fullPostedAt) { await fsSet("lboard_index/stamps", [[["users", id, doneK], -2]]); continue; }
          if (now - u[atK] > LATE_MS) { await fsSet("lboard_index/stamps", [[["users", id, doneK], -1]]); continue; }   // 古い分は出さない
          try {
            const ch = await channelFor(client, false);
            await sendCelebration(client, ch, cfg, id, u, kind, "", true);
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
