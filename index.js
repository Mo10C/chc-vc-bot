/* =============================================================
   chc-vc-bot — DiscordのVC滞在時間と、チャットの「感謝の言葉」を記録するBot

   ① VC：誰がどのVCに何分いたか → lboard_index/vc_YYYY-MM（vc.html・管理画面「VC稼働」）
   ② 感謝ワード：チャットで「ありがとう」などが何回言われたか → lboard_index/thanks_YYYY-MM
      （管理画面「感謝ワード」。数える言葉・期間もそこで決める）

   ③ 急上昇：毎日23:50、その日のLP集計（23:45）から「スタートからの伸び」「1日の伸び」の画像を連絡事項へ投稿
      （文面は管理画面「メッセージ」で編集。rising-poster.js）
   ④ 先生スナップショット：Worker が 23:45 に出した結果と表彰を、③と同じ体裁の画像で連絡事項へ投稿
      （画像の出し方は管理画面「先生スナップショット」で選ぶ。snapshot-poster.js）

   ②のためにメッセージを「読む」こと、③④の投稿以外はメッセージを送りません。
   本文は保存しません（数えた回数だけを保存します）。

   ★ ②を使うには Developer Portal → Bot →「MESSAGE CONTENT INTENT」をオンにしてください。
     オフのままでも①のVC記録はそのまま動きます（②だけ止まり、ログに案内が出ます）。

   環境変数（Railway の Variables に入れる）
     DISCORD_BOT_TOKEN    TOOLSのWorkerで使っているものと同じでOK
     FIREBASE_PROJECT_ID  例 tft-leaderboard-f6897
     FIREBASE_API_KEY     config.js の apiKey と同じ
     VC_DATA_DIR          /data（Railwayで付けたVolumeのマウント先）
     DISCORD_SCHEDULE_CHANNEL_ID  ③の投稿先（Cloudflare の Worker と同じ「連絡事項」のID）
     SITE_URL             （任意）サイトのURL。ランクの紋章をサイト内のパスで設定しているとき用
   ============================================================= */
"use strict";

// ローカルPCで試すとき用（.env を置いていれば読む。無ければ何もしない）
try { require("dotenv").config(); } catch (e) { }

const { Client, GatewayIntentBits } = require("discord.js");
const { startVcTracker } = require("./vc-tracker");
const { startThanksTracker } = require("./thanks-tracker");
const { startRisingPoster } = require("./rising-poster");
const { startSnapshotPoster } = require("./snapshot-poster");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN が設定されていません。Railway の Variables を確認してください。");
  process.exit(1);
}

/* MESSAGE CONTENT INTENT がオンかどうかを、ログインの前に確かめる。
   オフのまま要求するとログインごと失敗して、VC記録まで止まってしまうため。 */
async function messageContentEnabled() {
  try {
    const r = await fetch("https://discord.com/api/v10/applications/@me", { headers: { Authorization: "Bot " + TOKEN } });
    if (!r.ok) return false;
    const app = await r.json();
    const GATEWAY_MESSAGE_CONTENT = 1 << 18, GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
    return !!((app.flags || 0) & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED));
  } catch (e) { return false; }
}

(async () => {
  const withThanks = await messageContentEnabled();
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates     // ★これが無いとVCの出入りが届きません
  ];
  if (withThanks) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);

  const client = new Client({ intents });
  client.on("error", e => console.error("[discord] エラー", e));
  client.on("shardDisconnect", (ev, id) => console.warn("[discord] 接続が切れました shard " + id));

  startVcTracker(client);
  startRisingPoster(client);   // ③ 毎日23:50 急上昇プレイヤーの画像を連絡事項へ
  startSnapshotPoster(client); // ④ 先生スナップショットの結果・表彰を、同じ体裁の画像で連絡事項へ
  if (withThanks) startThanksTracker(client);
  else console.warn("[thanks] MESSAGE CONTENT INTENT がオフなので、感謝ワードは数えません。" +
    "Developer Portal → Bot → MESSAGE CONTENT INTENT をオンにして、Railway で Restart してください（VC記録はこのまま動きます）");

  client.login(TOKEN);
})();
