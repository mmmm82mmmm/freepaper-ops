/* ============================================================
   kintone プロキシ（Cloudflare Worker）

   ★トークンはこのコードに書かない★
   Cloudflare の「Variables and Secrets」に以下を登録すること：
     TOKEN_NOHON  … 納本アプリ（ID 269）のAPIトークン
     TOKEN_MASTER … マスタアプリ（ID 268）のAPIトークン

   トークンの決め方：
     1. リクエストヘッダーに X-Cybozu-API-Token があればそれを使う
        （管理ツールで権限の強いトークンを手入力する用途）
     2. 無ければアプリIDに応じて上記Secretを使う
        この場合は参照元（Origin）が正規のページであることを必須とする
   ============================================================ */
export default {
  async fetch(request, env) {
    const ALLOWED_ORIGIN = 'https://mmmm82mmmm.github.io';
    const SUBDOMAIN = 'white';                 // 接続先を固定（第三者による他ドメイン中継を防ぐ）
    const APP_TOKENS = {
      '269': env.TOKEN_NOHON,                  // 納本
      '268': env.TOKEN_MASTER,                 // マスタ
    };
    const ALLOWED_PATH = /^\/k\/v1\/(records|record)\.json$/;

    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Cybozu-API-Token',
    };
    const deny = (msg, code) => new Response(
      JSON.stringify({ message: msg }),
      { status: code, headers: { 'Content-Type': 'application/json', ...cors } }
    );

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/kintone/, '/k');
    if (!ALLOWED_PATH.test(path)) return deny('許可されていないパスです', 403);

    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.text();

    // アプリIDを特定（GETはクエリ、POST/PUT/DELETEはボディ）
    let app = url.searchParams.get('app') || '';
    if (!app && body) { try { app = String(JSON.parse(body).app ?? ''); } catch (e) {} }

    // トークン決定
    const clientToken = request.headers.get('X-Cybozu-API-Token') || '';
    let token = clientToken;
    if (!token) {
      const origin = request.headers.get('Origin') || '';
      const referer = request.headers.get('Referer') || '';
      const fromOurPage = origin === ALLOWED_ORIGIN || referer.startsWith(ALLOWED_ORIGIN + '/');
      if (!fromOurPage) return deny('許可されていない参照元です', 403);
      token = APP_TOKENS[app] || '';
      if (!token) return deny(`アプリID ${app || '(未指定)'} は許可されていません`, 403);
    }

    const query = url.searchParams.get('query') || '';
    const id = url.searchParams.get('id') || '';
    let qs = '';
    if (app)   qs += `app=${app}`;
    if (query) qs += `${qs ? '&' : ''}query=${encodeURIComponent(query)}`;
    if (id)    qs += `${qs ? '&' : ''}id=${id}`;

    const kintoneUrl = `https://${SUBDOMAIN}.cybozu.com${path}?${qs}`;
    const headers = { 'X-Cybozu-API-Token': token, 'X-Requested-With': 'XMLHttpRequest' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(kintoneUrl, { method: request.method, headers, body });
    const text = await res.text();

    // 応答は必ずJSONで返す（クライアントが res.json() を前提にしているため）
    let out = text;
    try { JSON.parse(text); } catch (e) { out = JSON.stringify({ _raw: text.slice(0, 200) }); }

    return new Response(out, {
      status: res.status,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  },
};
