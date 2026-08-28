/* ============================================================
   納本システム kintone プロキシ ＋ 認証（Cloudflare Worker）

   ■ここが唯一の関所です■
   画面（HTML）側のログイン表示はあくまで見た目で、
   実際の入場チェックはすべてこのファイルで行います。
   ログイン画面を飛ばして直接ブックマークを開いても、
   有効な入館証が無ければデータは 1 件も返しません。

   ------------------------------------------------------------
   Cloudflare 側で設定するもの（詳細は docs/ログイン設定手順.md）

   [Variables and Secrets]
     TOKEN_NOHON   … 納本アプリ（ID 269）の kintone APIトークン
     TOKEN_MASTER  … マスタアプリ（ID 268）の kintone APIトークン
     AUTH_SECRET   … 入館証の署名鍵（長いランダム文字列）
     ROSTER_URL    … 名簿API（GAS ウェブアプリ）のURL
     ROSTER_KEY    … 名簿APIの合言葉

   [KV Namespace Bindings]
     AUTH_KV       … 名簿キャッシュとPIN失敗回数の記録用

   ------------------------------------------------------------
   ■移行モード（切り替え作業のときだけ使う）■
     LEGACY_ALLOW = 1 を登録しておくと、入館証を持たない
     古い画面からのアクセスも通します（従来どおり参照元だけで判定）。

     手順：
       1. LEGACY_ALLOW = 1 を入れた状態でこのWorkerをデプロイ
          → 画面は今まで通り動く（止まらない）
       2. ログイン対応のHTMLを公開し、実際にログインできるか確認
       3. 確認できたら LEGACY_ALLOW を削除して再デプロイ
          → 入館証がないアクセスは通らなくなる（本番運用）

     3を済ませるまでは、URLを知っていれば誰でも読み書きできる
     状態のままです。確認が済んだら必ず削除してください。
   ------------------------------------------------------------
   ------------------------------------------------------------ */

const ALLOWED_ORIGIN = 'https://mmmm82mmmm.github.io';
const SUBDOMAIN      = 'white';                       // 接続先を固定
const ALLOWED_PATH   = /^\/k\/v1\/(records|record)\.json$/;

const TOKEN_TTL_SEC   = 90 * 24 * 60 * 60;  // 入館証の有効期間：90日
const ROSTER_FRESH_SEC = 300;               // 名簿の再確認間隔：5分（退職の反映速度）
const ROSTER_STALE_SEC = 3600;              // 名簿APIが落ちた時に古い名簿を使う限界：1時間
const MAX_FAIL        = 10;                 // PIN連続失敗の上限
const LOCK_SEC        = 30 * 60;            // 上限に達した時のロック時間：30分

const CORS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Cybozu-API-Token',
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json', ...CORS },
});

const deny = (message, status) => json({ message }, status);

/* ===== 入館証（署名付きトークン）の発行と検証 ===== */

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

async function issueToken(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

async function verifyToken(token, secret) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let ok = false;
  try {
    const key = await hmacKey(secret);
    ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(body));
  } catch (e) { return null; }
  if (!ok) return null;

  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))); }
  catch (e) { return null; }

  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  return payload;
}

/* ===== 名簿（スプレッドシート）の取得とキャッシュ ===== */

async function getRoster(env) {
  const now = Math.floor(Date.now() / 1000);
  let cached = null;
  try { cached = await env.AUTH_KV.get('roster', 'json'); } catch (e) {}

  // 5分以内に取得済みならそのまま使う
  if (cached && (now - cached.fetchedAt) < ROSTER_FRESH_SEC) return cached.rows;

  try {
    const url = `${env.ROSTER_URL}?key=${encodeURIComponent(env.ROSTER_KEY)}`;
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`名簿API ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.rows)) throw new Error('名簿APIの形式が不正です');

    await env.AUTH_KV.put(
      'roster',
      JSON.stringify({ rows: data.rows, fetchedAt: now }),
      { expirationTtl: ROSTER_STALE_SEC }
    );
    return data.rows;
  } catch (e) {
    // 名簿APIが一時的に落ちた場合は、1時間以内の古い名簿でしのぐ。
    // それも無ければ通さない（安全側に倒す）。
    if (cached && (now - cached.fetchedAt) < ROSTER_STALE_SEC) return cached.rows;
    return null;
  }
}

function findMember(rows, no) {
  const key = String(no || '').trim().toUpperCase();
  if (!key) return null;
  return rows.find(r => String(r.no || '').trim().toUpperCase() === key) || null;
}

/* ===== PIN の照合（総当たり対策つき） ===== */

function pinMatches(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  // 桁数が合う場合は入力全体を必ず比較する（早期 return で桁を推測されないため）
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return deny('入力を読み取れませんでした。', 400); }

  const no  = String(body.no  || '').trim().toUpperCase();
  const pin = String(body.pin || '').trim();
  if (!no || !pin) return deny('従業員NO と PIN を入力してください。', 400);

  const failKey = `fail:${no}`;
  const now = Math.floor(Date.now() / 1000);

  let fail = null;
  try { fail = await env.AUTH_KV.get(failKey, 'json'); } catch (e) {}
  if (fail && fail.until && fail.until > now) {
    const min = Math.ceil((fail.until - now) / 60);
    return deny(`PIN の入力を続けて間違えたため、一時的にロックされています。約 ${min} 分後にもう一度お試しください。`, 429);
  }

  const rows = await getRoster(env);
  if (!rows) return deny('名簿を確認できませんでした。しばらく待って再度お試しください。', 503);

  const member = findMember(rows, no);
  const okPin  = member ? pinMatches(member.pin, pin) : false;

  if (!member || !okPin) {
    const n = (fail && fail.n ? fail.n : 0) + 1;
    const rec = n >= MAX_FAIL ? { n: 0, until: now + LOCK_SEC } : { n, until: 0 };
    try { await env.AUTH_KV.put(failKey, JSON.stringify(rec), { expirationTtl: LOCK_SEC }); } catch (e) {}
    if (rec.until) return deny(`PIN を ${MAX_FAIL} 回間違えました。30 分後にもう一度お試しください。`, 429);
    return deny('従業員NO または PIN が違います。', 401);
  }

  if (!isActive(member)) {
    return deny('このアカウントは現在ご利用いただけません。管理者へご連絡ください。', 403);
  }

  try { await env.AUTH_KV.delete(failKey); } catch (e) {}

  const payload = {
    no:    String(member.no).trim().toUpperCase(),
    name:  String(member.name || ''),
    role:  memberRoles(member).join('・'),   // 表示用（例：作業者・運転手）
    roles: memberRoles(member),               // 判定用
    iat:   now,
    exp:   now + TOKEN_TTL_SEC,
  };
  const token = await issueToken(payload, env.AUTH_SECRET);
  return json({ token, name: payload.name, role: payload.role, roles: payload.roles, exp: payload.exp });
}

/* ===== 役割 =====
   1 人が複数の役割を持てます（例：作業者と運転手を兼務）。
   名簿API は roles を配列で返しますが、旧形式（1列に文字で書く）も受け付けます。 */

function parseRoles(raw) {
  const list = String(raw == null ? '' : raw)
    .split(/[・、,\/／\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return list.length ? list : ['作業者'];
}

function memberRoles(member) {
  if (member && Array.isArray(member.roles)) {
    const list = member.roles.map(s => String(s).trim()).filter(Boolean);
    if (list.length) return list;
  }
  return parseRoles(member && member.role);
}

function isActive(member) {
  const v = member.active;
  if (v === true) return true;
  if (v === false || v == null) return false;
  const s = String(v).trim();
  return s !== '' && s !== '×' && s !== '-' && s !== '—' && s !== 'false' && s !== '0';
}

/* 移行モード用。旧Workerと同じく参照元だけで判定する。 */
function originAllowed(request) {
  const o = request.headers.get('Origin') || '';
  const r = request.headers.get('Referer') || '';
  return o === ALLOWED_ORIGIN || r.startsWith(ALLOWED_ORIGIN);
}

/* ===== リクエストの認証：入館証 ＋ 在籍確認 ===== */

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!raw) {
    // 切り替え作業中だけ、入館証を持たない古い画面を通す
    if (env.LEGACY_ALLOW === '1' && originAllowed(request)) {
      return { user: { no: '-', name: '(移行中)', role: '管理者', roles: ['管理者'] } };
    }
    return { error: deny('ログインが必要です。', 401) };
  }

  const payload = await verifyToken(raw, env.AUTH_SECRET);
  if (!payload) return { error: deny('ログインの有効期限が切れました。もう一度ログインしてください。', 401) };

  // 名簿を毎回確認する（キャッシュ5分）。退職＝在籍を消せば5分以内に締め出される。
  const rows = await getRoster(env);
  if (!rows) return { error: deny('名簿を確認できませんでした。しばらく待って再度お試しください。', 503) };

  const member = findMember(rows, payload.no);
  if (!member || !isActive(member)) {
    return { error: deny('このアカウントは現在ご利用いただけません。管理者へご連絡ください。', 401) };
  }

  // 役割は名簿側を正とする（トークン発行後に役割を変えても即反映される）
  const roles = memberRoles(member);
  return { user: { ...payload, role: roles.join('・'), roles } };
}

/* ===== kintone への中継 ===== */

async function handleProxy(request, env, user) {
  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/kintone/, '/k');
  if (!ALLOWED_PATH.test(path)) return deny('許可されていないパスです。', 403);

  // 兼務があるので「管理者を含むか」で判定する
  const isAdmin = Array.isArray(user.roles) && user.roles.indexOf('管理者') >= 0;

  if (request.method === 'DELETE' && !isAdmin) {
    return deny('レコードの削除は管理者のみ行えます。', 403);
  }

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') body = await request.text();

  // アプリIDを特定（GETはクエリ、POST/PUT/DELETEはボディ）
  let app = url.searchParams.get('app') || '';
  if (!app && body) { try { app = String(JSON.parse(body).app ?? ''); } catch (e) {} }

  // 管理ツールで強い権限のトークンを手入力する用途は管理者だけに許可する
  const clientToken = (request.headers.get('X-Cybozu-API-Token') || '').trim();
  let token;
  if (clientToken) {
    if (!isAdmin) return deny('この操作は管理者のみ行えます。', 403);
    token = clientToken;
  } else {
    const APP_TOKENS = { '269': env.TOKEN_NOHON, '268': env.TOKEN_MASTER };
    token = APP_TOKENS[app] || '';
    if (!token) return deny(`アプリID ${app || '(未指定)'} は許可されていません。`, 403);
  }

  const query = url.searchParams.get('query') || '';
  const id    = url.searchParams.get('id') || '';
  let qs = '';
  if (app)   qs += `app=${app}`;
  if (query) qs += `${qs ? '&' : ''}query=${encodeURIComponent(query)}`;
  if (id)    qs += `${qs ? '&' : ''}id=${id}`;

  const kintoneUrl = `https://${SUBDOMAIN}.cybozu.com${path}?${qs}`;
  const headers = { 'X-Cybozu-API-Token': token, 'X-Requested-With': 'XMLHttpRequest' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res  = await fetch(kintoneUrl, { method: request.method, headers, body });
  const text = await res.text();

  // 応答は必ずJSONで返す（クライアントが res.json() を前提にしているため）
  let out = text;
  try { JSON.parse(text); } catch (e) { out = JSON.stringify({ _raw: text.slice(0, 200) }); }

  return new Response(out, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

/* ===== 入口 ===== */

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
    }

    // 設定漏れは分かりやすく知らせる（原因不明の401を防ぐため）
    const missing = ['AUTH_SECRET', 'ROSTER_URL', 'ROSTER_KEY'].filter(k => !env[k]);
    if (missing.length) return deny(`Worker の設定が未完了です：${missing.join(', ')}`, 500);
    if (!env.AUTH_KV)   return deny('Worker の設定が未完了です：KV Namespace「AUTH_KV」が未バインドです', 500);

    const url = new URL(request.url);

    if (url.pathname === '/auth/login') {
      if (request.method !== 'POST') return deny('POST で送信してください。', 405);
      return handleLogin(request, env);
    }

    const auth = await authenticate(request, env);
    if (auth.error) return auth.error;

    if (url.pathname === '/auth/me') {
      return json({
        no: auth.user.no, name: auth.user.name,
        role: auth.user.role, roles: auth.user.roles, exp: auth.user.exp,
      });
    }

    return handleProxy(request, env, auth.user);
  },
};
