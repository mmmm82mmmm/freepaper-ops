/* ============================================================
   kintone 接続設定

   ★トークンはここには書きません★
   Cloudflare Worker 側の Secret（TOKEN_NOHON / TOKEN_MASTER）から
   自動的に付与されるため、空のままで正しく動作します。

   このファイルに秘密情報は含まれないので、
   リポジトリを公開しても問題ありません。
   ============================================================ */
const KINTONE_CONFIG = {
  PROXY:  'https://kintone-proxy.mmmm82mmmm.workers.dev',
  DOMAIN: 'white',

  // 空 = Worker側のSecretを使う（通常はこのまま）
  // 権限の強いトークンを一時的に使いたい管理ツールでは、
  // 画面のフォームに直接貼り付けてください。
  TOKEN_NOHON:  '',
  TOKEN_MASTER: '',
};
