/* =============================================================
   thanks-tracker.js — Discordのチャットの「感謝の言葉」を数える

   index.js から startThanksTracker(client) で起動します。
   ・数える言葉 / 期間 / 除外するチャンネルは、管理コンソール →「感謝ワード」で決めます
     （Firestore の lboard_index/thanks に保存され、Botが5分ごとに読みに行きます）
   ・数えた結果は lboard_index/thanks_YYYY-MM に日ごとに書きます
       days: { "2026-10-25": { <チャンネルID>: { n:名前, c:回数, m:メッセージ数, u:{ <ユーザーID>: 回数 } } } }
       names: { <ユーザーID>: 表示名 }
   ・スレッド・フォーラムの投稿は、親のチャンネルにまとめて数えます
   ・Botが落ちていた間の分も、起動したときに過去ログを読み直して取りこぼしません
   ・言葉・期間・除外を変えると、期間の最初から自動で数え直します

   必要なもの
     ・Developer Portal → Bot →「MESSAGE CONTENT INTENT」をオン
     ・Botのロールに「メッセージ履歴を読む」権限
   環境変数（VC記録と共通）
     VC_DATA_DIR / FIREBASE_PROJECT_ID / FIREBASE_API_KEY
     THANKS_PUSH_MIN   Firestore へ送る間隔・分（既定: 5）
   ============================================================= */
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.VC_DATA_DIR || path.join(__dirname, "data");
const FILE     = path.join(DATA_DIR, "thanks.json");
const TMP      = FILE + ".tmp";
const PUSH_MS  = Math.max(1, Number(process.env.THANKS_PUSH_MIN || 5)) * 60 * 1000;
const CFG_MS   = 5 * 60 * 1000;
const JST      = 9 * 60 * 60 * 1000;
const EPOCH    = 1420070400000n;   // Discord の ID の起点

// 管理コンソールで何も決めていないときの初期値（core.js の THANKS_DEFAULT と同じ）
const DEFAULT = {
  words: ["ありがとう", "ありがと", "有難う", "有り難う", "感謝", "サンキュー", "サンクス", "あざす", "あざっす", "あざます",
          "助かる", "助かった", "助かります", "お礼", "thanks", "thank you", "thx", "ty"],
  from: "2026-10-25", to: "2026-11-15", exclude: [], rescan: 0
};

let st = { sig: "", lastId: {}, days: {}, names: {} };
let cfg = null, matcher = null;
let scanning = false, scanned = 0;
const queue = [];                  // 読み直し中に届いたメッセージ（終わってから数える）
const dirtyDays = new Set();
let dirty = false;
let lastErr = "";

/* ---------------- 日付 ---------------- */
const dayKey = ms => new Date(ms + JST).toISOString().slice(0, 10);
const dayStart = k => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) - JST;
const idAtTime = ms => String((BigInt(Math.max(0, ms)) - EPOCH) << 22n);
const idCmp = (a, b) => { if (!b) return 1; if (!a) return -1; const x = BigInt(a), y = BigInt(b); return x > y ? 1 : x < y ? -1 : 0; };
function daysBetween(a, b) {
  const out = []; if (!a || !b || a > b) return out;
  for (let t = dayStart(a); dayKey(t) <= b; t += 86400000) out.push(dayKey(t));
  return out;
}

/* ---------------- 言葉の判定 ----------------
   全角半角・大文字小文字・カタカナひらがなの違いは同じとみなす。
   英語は単語の一部に当たらないように前後を見る（"ty" が "party" に当たらない）。
   長い言葉から先に当てるので「ありがとう」が「ありがと」と二重に数えられることはない。 */
function norm(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function buildMatcher(words) {
  const ws = [...new Set((words || []).map(norm).map(w => w.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ws.length) return null;
  const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = ws.map(w => /^[a-z0-9 ]+$/.test(w) ? "(?<![a-z0-9])" + esc(w) + "(?![a-z0-9])" : esc(w));
  return new RegExp(parts.join("|"), "g");
}
function countWords(text) {
  if (!matcher || !text) return 0;
  const m = norm(text).match(matcher);
  return m ? m.length : 0;
}

/* ---------------- 保存 ---------------- */
function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) {
      const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
      st = { sig: j.sig || "", lastId: j.lastId || {}, days: j.days || {}, names: j.names || {} };
    }
  } catch (e) { console.error("[thanks] 保存データを読めませんでした（最初から数えます）", e.message); }
}
function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(TMP, JSON.stringify(st));
    fs.renameSync(TMP, FILE);
    dirty = false;
  } catch (e) { console.error("[thanks] 保存に失敗", e.message); }
}

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
async function fsGet(docPath) {
  const r = await fetch(fsBase() + "/" + docPath + "?key=" + process.env.FIREBASE_API_KEY);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Firestore読み込み失敗 " + r.status);
  const j = await r.json();
  return dec({ mapValue: { fields: j.fields || {} } });
}
async function fsPatch(docPath, obj, mask) {
  const fields = {}; Object.entries(obj).forEach(([k, v]) => { fields[k] = enc(v); });
  const q = mask.map(p => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const r = await fetch(fsBase() + "/" + docPath + "?key=" + process.env.FIREBASE_API_KEY + "&" + q, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields })
  });
  if (!r.ok) throw new Error("Firestore書き込み失敗 " + r.status + " " + (await r.text()).slice(0, 200));
}

async function pushDays(days) {
  if (!fsReady()) return;
  const list = [...new Set(days)].filter(Boolean).sort();
  if (!list.length) return;
  const byMonth = {};
  list.forEach(d => (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d));
  for (const [m, ds] of Object.entries(byMonth)) {
    const obj = { days: {}, names: st.names, updatedAt: Date.now() };
    const mask = ["names", "updatedAt"];
    ds.forEach(d => { obj.days[d] = st.days[d] || {}; mask.push("days.`" + d + "`"); });   // 日付キーはバッククォートで囲む
    try { await fsPatch("lboard_index/thanks_" + m, obj, mask); }
    catch (e) { console.error("[thanks] 送信に失敗（次回また送ります）", e.message); ds.forEach(d => dirtyDays.add(d)); lastErr = e.message; return; }
  }
  console.log("[thanks] Firestoreへ送信: " + list.join(", "));
}

let chList = [];
async function pushStatus(state, msg) {
  if (!fsReady()) return;
  const total = Object.values(st.days).reduce((n, d) => n + Object.values(d).reduce((a, c) => a + (c.c || 0), 0), 0);
  try {
    await fsPatch("lboard_index/thanks", {
      bot: { at: Date.now(), state, msg: msg || "", scanned, total, from: cfg ? cfg.from : "", to: cfg ? cfg.to : "",
             err: lastErr, channels: chList }
    }, ["bot"]);
  } catch (e) { console.error("[thanks] 状態を送れませんでした", e.message); }
}

/* ---------------- 設定 ---------------- */
function sigOf(c) {
  return JSON.stringify([[...c.words].map(norm).sort(), c.from, c.to, [...c.exclude].sort(), c.rescan || 0]);
}
async function loadConfig() {
  let raw = null;
  if (fsReady()) {
    try { raw = await fsGet("lboard_index/thanks"); }
    catch (e) { console.error("[thanks] 設定を読めませんでした（前の設定で続けます）", e.message); return false; }
  }
  raw = raw || {};
  const c = {
    words: Array.isArray(raw.words) && raw.words.length ? raw.words.map(String) : DEFAULT.words,
    from: /^\d{4}-\d{2}-\d{2}$/.test(raw.from || "") ? raw.from : DEFAULT.from,
    to: /^\d{4}-\d{2}-\d{2}$/.test(raw.to || "") ? raw.to : DEFAULT.to,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
    rescan: Number(raw.rescan) || 0
  };
  const sig = sigOf(c);
  cfg = c; matcher = buildMatcher(c.words);
  if (st.sig === sig) return false;
  // 言葉・期間・除外が変わった → 最初から数え直す（前の期間の日も空で送り直して消す）
  const old = Object.keys(st.days);
  console.log("[thanks] 設定が変わったので、" + c.from + " 〜 " + c.to + " を最初から数え直します");
  st = { sig, lastId: {}, days: {}, names: {} };
  old.concat(daysBetween(c.from, c.to)).forEach(d => dirtyDays.add(d));
  dirty = true;
  return true;
}

/* ---------------- 1通ずつ数える ---------------- */
function parentOf(ch) {
  if (ch && typeof ch.isThread === "function" && ch.isThread() && ch.parent) return ch.parent;
  return ch;
}
function handle(m) {
  if (!m || !m.guild || !m.author || m.author.bot || m.system) return;
  if (idCmp(m.id, st.lastId[m.channelId]) <= 0) return;      // もう数えた
  st.lastId[m.channelId] = m.id; dirty = true;
  if (!cfg) return;
  const d = dayKey(m.createdTimestamp);
  if (d < cfg.from || d > cfg.to) return;
  const p = parentOf(m.channel);
  const pid = p ? p.id : m.channelId;
  if (cfg.exclude.includes(pid)) return;
  const n = countWords(m.content);
  if (!n) return;
  const day = st.days[d] || (st.days[d] = {});
  const e = day[pid] || (day[pid] = { n: "", c: 0, m: 0, u: {} });
  e.n = (p && p.name) || e.n || pid;
  e.c += n; e.m += 1;
  e.u[m.author.id] = (e.u[m.author.id] || 0) + n;
  st.names[m.author.id] = (m.member && m.member.displayName) || m.author.globalName || m.author.username;
  dirtyDays.add(d);
}

/* ---------------- 過去ログを読む ---------------- */
const TEXT_TYPES = new Set([0, 2, 5, 13]);   // テキスト・VCのチャット・アナウンス・ステージ
async function listChannels(client) {
  const out = [];
  for (const guild of client.guilds.cache.values()) {
    try { await guild.channels.fetch(); } catch (e) { }
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const can = ch => { try { return !me || ch.permissionsFor(me).has(["ViewChannel", "ReadMessageHistory"]); } catch (e) { return false; } };
    const base = [...guild.channels.cache.values()].filter(ch => TEXT_TYPES.has(ch.type) && can(ch));
    const threads = [];
    try { const a = await guild.channels.fetchActiveThreads(); a.threads.forEach(t => threads.push(t)); } catch (e) { }
    // 期間中にアーカイブされたスレッド（フォーラムの投稿も）
    for (const ch of guild.channels.cache.values()) {
      if (!ch.threads || !can(ch)) continue;
      try { const a = await ch.threads.fetchArchived({ type: "public", limit: 100 }); a.threads.forEach(t => threads.push(t)); } catch (e) { }
    }
    // 管理画面の「除外」で選べるように、親チャンネルの一覧（スレッドを持つフォーラムも）
    const parents = new Map();
    base.forEach(ch => parents.set(ch.id, ch));
    threads.forEach(t => { if (t.parent && can(t.parent)) parents.set(t.parent.id, t.parent); });
    [...parents.values()].forEach(ch => out.push({ id: ch.id, n: ch.name, t: ch.type }));
    out._scan = (out._scan || []).concat(base, threads.filter(t => !t.parent || can(t.parent)));
  }
  return out;
}
async function scanChannel(ch) {
  const startMs = dayStart(cfg.from), endMs = dayStart(cfg.to) + 86400000;
  // そのチャンネルで最後に届いたメッセージが期間より前なら読まない
  if (ch.lastMessageId && idCmp(ch.lastMessageId, idAtTime(startMs)) < 0) return;
  let after = st.lastId[ch.id] || idAtTime(startMs - 1);
  for (;;) {
    let batch;
    try { batch = await ch.messages.fetch({ after, limit: 100, cache: false }); }
    catch (e) { return; }   // 権限がない・消えたチャンネルなど
    if (!batch || !batch.size) break;
    const arr = [...batch.values()].sort((a, b) => idCmp(a.id, b.id));
    for (const m of arr) { handle(m); scanned++; }
    const last = arr[arr.length - 1];
    after = last.id;
    if (!st.lastId[ch.id] || idCmp(after, st.lastId[ch.id]) > 0) st.lastId[ch.id] = after;
    if (last.createdTimestamp >= endMs || batch.size < 100) break;
  }
}
async function scanAll(client) {
  if (scanning || !cfg) return;
  scanning = true; scanned = 0;
  try {
    const list = await listChannels(client);
    chList = list.map(x => ({ id: x.id, n: x.n }));
    const targets = list._scan || [];
    await pushStatus("scanning", targets.length + "チャンネルの過去ログを読んでいます");
    console.log("[thanks] 過去ログを読み直します: " + targets.length + "チャンネル（" + cfg.from + " 〜 " + cfg.to + "）");
    for (const ch of targets) {
      if (cfg.exclude.includes((parentOf(ch) || ch).id)) continue;
      await scanChannel(ch);
    }
    console.log("[thanks] 読み直し完了: " + scanned + "通を確認");
  } catch (e) { console.error("[thanks] 読み直しに失敗", e.message); lastErr = e.message; }
  scanning = false;
  // 読み直し中に届いたぶん
  queue.splice(0).forEach(handle);
  save();
  const ds = [...dirtyDays]; dirtyDays.clear();
  await pushDays(ds);
  await pushStatus("ok", "");
}

/* ---------------- 起動 ---------------- */
function startThanksTracker(client) {
  load();
  if (!fsReady()) console.warn("[thanks] FIREBASE_PROJECT_ID / FIREBASE_API_KEY が未設定です。数えますが画面には出ません");

  let started = false;
  const onReady = async () => {
    if (started) return; started = true;
    await loadConfig();
    await scanAll(client);   // 落ちていた間の取りこぼしも、ここで拾う
  };
  client.once("clientReady", onReady);
  client.once("ready", onReady);

  client.on("messageCreate", m => {
    if (scanning) { queue.push(m); return; }
    handle(m);
  });

  const t1 = setInterval(() => { if (dirty) save(); }, 60 * 1000);
  const t2 = setInterval(async () => {
    const ds = [...dirtyDays]; dirtyDays.clear();
    await pushDays(ds);
    await pushStatus(scanning ? "scanning" : "ok", "");
  }, PUSH_MS);
  const t3 = setInterval(async () => {
    if (!started || scanning) return;
    if (await loadConfig()) await scanAll(client);   // 設定が変わったら数え直す
  }, CFG_MS);
  [t1, t2, t3].forEach(t => t.unref && t.unref());

  process.on("SIGTERM", () => save());
  process.on("SIGINT", () => save());
}

module.exports = { startThanksTracker, _countWords: (w, t) => { matcher = buildMatcher(w); return countWords(t); }, _norm: norm };
