/* ============================================================
   納本システム 共通ログイン（従業員NO + PIN）

   すべての画面が config.js の直後にこのファイルを読み込みます。
   役割：
     1. ログイン済みでなければ全画面をログイン画面で覆う
     2. Worker への通信すべてに入館証（トークン）を自動で添える
     3. 入館証が無効になったら（退職・期限切れ）ログイン画面に戻す

   ★PIN はこのファイルに保存しません。照合は Worker 側で行います。
   ============================================================ */
(function () {
  'use strict';

  var STORAGE_KEY = 'fp_auth_token';
  var cfg   = (typeof KINTONE_CONFIG !== 'undefined') ? KINTONE_CONFIG : {};
  var PROXY = String(cfg.PROXY || '').replace(/\/+$/, '');
  var PROXY_HOST = '';
  try { PROXY_HOST = new URL(PROXY).host; } catch (e) { PROXY_HOST = ''; }

  var token = null;
  var user  = null;
  var overlayShown = false;
  var denied = false;

  /* ===== 画面ごとの利用制限 =====
     ここに書いた画面は、指定の役割を持つ人だけが開けます。
     役割を増やしたい時はこの表に 1 行足すだけです。

     ※これは誤タップ防止の案内です。データそのものの防御は Worker 側で
       行っています（入館証の検証と在籍確認）。 */
  var PAGE_ROLES = {
    'driver.html': ['運転手', '管理者']
  };

  // ===== トークンの読み書き =====
  function b64urlToStr(b64) {
    var s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function decodePayload(t) {
    try { return JSON.parse(b64urlToStr(String(t).split('.')[0])); }
    catch (e) { return null; }
  }

  function clearToken() {
    token = null; user = null;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function loadToken() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    var p = decodePayload(raw);
    // 期限切れはここで捨てる（本当の検証は Worker 側）
    if (p && p.exp && p.exp * 1000 > Date.now()) { token = raw; user = p; }
    else { clearToken(); }
  }

  // ===== 役割と画面の対応 =====
  function fileNameOf(pathOrHref) {
    var s = String(pathOrHref || '').split('#')[0].split('?')[0];
    s = s.substring(s.lastIndexOf('/') + 1);
    try { s = decodeURIComponent(s); } catch (e) {}
    return s;
  }

  function myRoles() {
    if (!user) return [];
    if (Array.isArray(user.roles)) return user.roles;
    if (user.role) return String(user.role).split(/[・、,\/／\s]+/).filter(Boolean);
    return [];
  }

  function canOpen(fileName) {
    var need = PAGE_ROLES[fileName];
    if (!need) return true;
    var mine = myRoles();
    for (var i = 0; i < need.length; i++) {
      if (mine.indexOf(need[i]) >= 0) return true;
    }
    return false;
  }

  // ===== fetch の横取り：Worker 宛にだけ入館証を添える =====
  var origFetch = window.fetch ? window.fetch.bind(window) : null;

  function isProxyUrl(url) {
    if (!PROXY_HOST) return false;
    return String(url).indexOf(PROXY_HOST) >= 0;
  }

  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input
              : (input && input.url) ? input.url : '';

      if (!isProxyUrl(url)) return origFetch(input, init);

      if (denied) return Promise.reject(new Error('この画面は利用できません'));

      if (!token) {
        showOverlay('ログインしてください。');
        return Promise.reject(new Error('未ログインです'));
      }

      var opts = init ? Object.assign({}, init) : {};
      var headers = new Headers(
        (init && init.headers) ||
        ((typeof input !== 'string' && input && input.headers) ? input.headers : {})
      );
      headers.set('Authorization', 'Bearer ' + token);
      opts.headers = headers;

      return origFetch(input, opts).then(function (res) {
        if (res.status === 401) {
          clearToken();
          showOverlay('ログインの有効期限が切れました。もう一度ログインしてください。');
        }
        return res;
      });
    };
  }

  // ===== ログイン画面 =====
  var CSS = [
    '.fp-mask{position:fixed;inset:0;z-index:2147483647;background:#f4f0e8;',
    'font-family:"Noto Sans JP",sans-serif;color:#1a1a1a;overflow-y:auto;',
    'display:flex;align-items:center;justify-content:center;padding:24px;}',
    '.fp-mask *{box-sizing:border-box;}',
    '#fp-login-box{background:#fff;border-radius:16px;padding:28px 22px;width:100%;max-width:380px;',
    'box-shadow:0 4px 20px rgba(0,0,0,.10);}',
    '#fp-login-box .ic{font-size:40px;text-align:center;}',
    '#fp-login-box h1{font-size:19px;font-weight:900;text-align:center;margin:8px 0 4px;letter-spacing:.04em;}',
    '#fp-login-box .sub{font-size:11px;color:#888;text-align:center;margin-bottom:22px;letter-spacing:.04em;}',
    '#fp-login-box label{display:block;font-size:11px;font-weight:900;color:#888;',
    'letter-spacing:.08em;margin:0 0 6px 2px;}',
    '#fp-login-box input{width:100%;padding:14px;font-size:17px;border:1px solid #e0dbd0;',
    'border-radius:10px;font-family:inherit;background:#fafafa;margin-bottom:16px;}',
    '#fp-login-box input:focus{outline:none;border-color:#1a5cd4;background:#fff;}',
    '#fp-login-btn{width:100%;padding:15px;font-size:16px;font-weight:900;color:#fff;',
    'background:#1a1a1a;border:none;border-radius:10px;font-family:inherit;cursor:pointer;letter-spacing:.08em;}',
    '#fp-login-btn:active{background:#000;}',
    '#fp-login-btn:disabled{background:#bbb;cursor:default;}',
    '#fp-login-err{display:none;background:#fdecec;border:1px solid #f0b0b0;color:#a01818;',
    'border-radius:10px;padding:11px 13px;font-size:12px;line-height:1.7;margin-bottom:16px;}',
    '#fp-login-box .note{font-size:11px;color:#888;text-align:center;margin-top:18px;line-height:1.8;}'
  ].join('');

  var HTML = [
    '<div id="fp-login-box">',
    '  <div class="ic">📦</div>',
    '  <h1>納本システム</h1>',
    '  <div class="sub">FreePaper Ops</div>',
    '  <div id="fp-login-err"></div>',
    '  <label for="fp-login-no">従業員NO</label>',
    '  <input id="fp-login-no" type="text" autocomplete="username" autocapitalize="characters"',
    '         autocorrect="off" spellcheck="false" placeholder="W001">',
    '  <label for="fp-login-pin">PIN</label>',
    '  <input id="fp-login-pin" type="password" autocomplete="current-password"',
    '         inputmode="numeric" maxlength="8" placeholder="4桁の数字">',
    '  <button id="fp-login-btn" type="button">ログイン</button>',
    '  <div class="note">PIN が分からない場合は<br>管理者へご連絡ください。</div>',
    '</div>'
  ].join('\n');

  var cssDone = false;
  function injectCss() {
    if (cssDone) return;
    cssDone = true;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function setError(msg) {
    var el = document.getElementById('fp-login-err');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }

  function showOverlay(message) {
    if (overlayShown) {
      if (message) setError(message);
      return;
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { showOverlay(message); });
      return;
    }
    overlayShown = true;
    injectCss();

    var mask = document.createElement('div');
    mask.id = 'fp-login-mask';
    mask.className = 'fp-mask';
    mask.innerHTML = HTML;
    document.body.appendChild(mask);
    document.documentElement.style.overflow = 'hidden';

    var noEl  = document.getElementById('fp-login-no');
    var pinEl = document.getElementById('fp-login-pin');
    var btn   = document.getElementById('fp-login-btn');

    noEl.addEventListener('input', function () {
      this.value = this.value.toUpperCase().replace(/\s/g, '');
    });
    [noEl, pinEl].forEach(function (el) {
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
      });
    });
    btn.addEventListener('click', submit);

    if (message) setError(message);

    // 前回の従業員NOを覚えておく（PIN は保存しない）
    var last = null;
    try { last = localStorage.getItem('fp_auth_last_no'); } catch (e) {}
    if (last) { noEl.value = last; pinEl.focus(); } else { noEl.focus(); }
  }

  function submit() {
    var noEl  = document.getElementById('fp-login-no');
    var pinEl = document.getElementById('fp-login-pin');
    var btn   = document.getElementById('fp-login-btn');
    var no  = (noEl.value  || '').trim().toUpperCase();
    var pin = (pinEl.value || '').trim();

    if (!no || !pin) { setError('従業員NO と PIN の両方を入力してください。'); return; }

    setError('');
    btn.disabled = true;
    btn.textContent = '確認中…';

    var done = false;

    // ログインだけは横取りしていない素の fetch を使う
    origFetch(PROXY + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ no: no, pin: pin })
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return {}; })
          .then(function (j) { return { ok: res.ok, body: j }; });
      })
      .then(function (r) {
        if (!r.ok) {
          setError(r.body && r.body.message ? r.body.message : 'ログインできませんでした。');
          pinEl.value = '';
          pinEl.focus();
          return;
        }
        try {
          localStorage.setItem(STORAGE_KEY, r.body.token);
          localStorage.setItem('fp_auth_last_no', no);
        } catch (e) {}
        done = true;
        btn.textContent = '読み込み中…';
        // 画面を作り直して通常の初期化を走らせる
        location.reload();
      })
      .catch(function () {
        setError('通信に失敗しました。電波の状態を確認してもう一度お試しください。');
      })
      .then(function () {
        if (done) return;
        btn.disabled = false;
        btn.textContent = 'ログイン';
      });
  }

  // ===== 開けない画面を開いた時の案内 =====
  function showDenied() {
    denied = true;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showDenied);
      return;
    }
    if (document.getElementById('fp-denied-mask')) return;
    injectCss();

    var need = (PAGE_ROLES[fileNameOf(location.pathname)] || []).join('・');
    var mask = document.createElement('div');
    mask.id = 'fp-denied-mask';
    mask.className = 'fp-mask';
    mask.innerHTML = [
      '<div id="fp-login-box" style="text-align:center">',
      '  <div class="ic">🚫</div>',
      '  <h1>この画面は使えません</h1>',
      '  <div class="sub">' + (user && user.name ? user.name + ' さん' : '') + '</div>',
      '  <p style="font-size:13px;line-height:1.9;color:#333;margin-bottom:20px;">',
      '    この画面は<b>' + need + '</b>の方だけが開けます。<br>',
      '    メニューから作業する画面を開いてください。',
      '  </p>',
      '  <a href="./index.html" style="display:block;width:100%;padding:15px;background:#1a1a1a;',
      '     color:#fff;text-decoration:none;border-radius:10px;font-size:16px;font-weight:900;">',
      '    ▶ メニューに戻る</a>',
      '  <div class="note">役割の変更が必要な場合は<br>管理者へご連絡ください。</div>',
      '</div>'
    ].join('\n');
    document.body.appendChild(mask);
    document.documentElement.style.overflow = 'hidden';
  }

  // 開けない画面へのリンクはメニューから隠す（押してから断られるのを避ける）
  function hideForbiddenLinks() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', hideForbiddenLinks);
      return;
    }
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var name = fileNameOf(links[i].getAttribute('href'));
      if (PAGE_ROLES[name] && !canOpen(name)) links[i].style.display = 'none';
    }
  }

  // ===== 起動 =====
  loadToken();
  if (!token) {
    showOverlay('');
  } else if (!canOpen(fileNameOf(location.pathname))) {
    showDenied();
  } else {
    hideForbiddenLinks();
  }

  window.FP_AUTH = {
    get user()  { return user; },
    get token() { return token; },
    logout: function () { clearToken(); location.reload(); }
  };
})();
