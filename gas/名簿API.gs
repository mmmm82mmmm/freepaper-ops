/* ============================================================
   納本システム 作業員名簿API（Google Apps Script）

   スプレッドシートの「名簿」シートを読み、Cloudflare Worker にだけ
   JSON で返します。スプレッドシート自体は非公開のままで構いません。
   （※「ウェブに公開」は絶対にしないでください。PIN が誰でも読める
     状態になります。このスクリプト経由でのみ読み出します。）

   役割はチェックボックスで、1 人が複数持てます。
   （例：作業者もやるし運転もする人は、両方にチェック）

   使い方は docs/ログイン設定手順.md を参照。
   ざっくり：
     1. スプレッドシートを開く → 拡張機能 → Apps Script
     2. このコードを貼り付けて保存
     3. メニュー「納本システム」→「名簿シートを準備」を実行
     4. メニュー「納本システム」→「合言葉(ROSTER_KEY)を作成」を実行
     5. デプロイ → 新しいデプロイ → ウェブアプリ
        （実行ユーザー：自分／アクセス：全員）
     6. 発行された URL を Worker の ROSTER_URL に設定
   ============================================================ */

const SHEET_NAME = '名簿';
const ROLE_LABELS = ['作業者', '運転手', '管理者'];
const HEADERS = ['従業員NO', '氏名', 'PIN'].concat(ROLE_LABELS).concat(['在籍']);

/* ===== Worker からの問い合わせ窓口 ===== */
function doGet(e) {
  const given = (e && e.parameter && e.parameter.key) || '';
  const expected = PropertiesService.getScriptProperties().getProperty('ROSTER_KEY') || '';

  // 合言葉が未設定、または一致しない場合は名簿を返さない
  if (!expected || given !== expected) {
    return jsonOut({ error: 'forbidden' });
  }

  try {
    return jsonOut({ rows: readRoster() });
  } catch (err) {
    return jsonOut({ error: String(err) });
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ===== 名簿シートの読み取り ===== */
function readRoster() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error(`シート「${SHEET_NAME}」が見つかりません`);

  // getDisplayValues を使うことで PIN の先頭ゼロ（0123 など）が保たれます
  const values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const head = values[0].map(v => String(v).trim());
  const col = name => head.indexOf(name);

  const iNo     = col('従業員NO');
  const iName   = col('氏名');
  const iPin    = col('PIN');
  const iActive = col('在籍');
  const iRoleOld = col('役割');                    // 旧形式（1列に文字で書く）も受け付ける
  const roleCols = ROLE_LABELS.map(label => [label, col(label)]);

  if (iNo < 0 || iPin < 0) throw new Error('見出し行に「従業員NO」「PIN」が必要です');

  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const no = String(row[iNo] || '').trim().toUpperCase();
    if (!no) continue;

    rows.push({
      no:     no,
      name:   iName   >= 0 ? String(row[iName] || '').trim() : '',
      pin:    String(row[iPin] || '').trim(),
      roles:  readRoles(row, roleCols, iRoleOld),
      active: iActive >= 0 ? isChecked(row[iActive]) : true,
    });
  }
  return rows;
}

// 役割はチェックボックス列から集める（複数可）
function readRoles(row, roleCols, iRoleOld) {
  const roles = [];
  roleCols.forEach(function (pair) {
    const label = pair[0], idx = pair[1];
    if (idx >= 0 && isChecked(row[idx])) roles.push(label);
  });

  // チェックボックス列が無い／全部空の場合は、旧「役割」列の文字を読む
  // 区切りは中黒・読点・カンマ・スラッシュ・空白のいずれも受け付ける。
  // （「作業者・管理者」を分解できず、既定の「作業者」だけになる不具合があった）
  if (!roles.length && iRoleOld >= 0) {
    String(row[iRoleOld] || '')
      .split(/[・、，,\/／\s]+/)
      .map(s => s.trim())
      .filter(s => ROLE_LABELS.indexOf(s) >= 0)
      .forEach(s => { if (roles.indexOf(s) < 0) roles.push(s); });
  }

  // 何も指定が無い人は作業者として扱う
  return roles.length ? roles : ['作業者'];
}

// チェックボックス（TRUE/FALSE）と手書きの ○ / × の両方に対応する
function isChecked(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return false;
  if (s === '×' || s === 'x' || s === 'X' || s === '-' || s === '—') return false;
  if (s.toUpperCase() === 'FALSE' || s === '0') return false;
  return true;
}

/* ===== 初期設定：メニューから実行 ===== */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('納本システム')
    .addItem('名簿シートを準備', 'setupRosterSheet')
    .addItem('合言葉(ROSTER_KEY)を作成', 'generateRosterKey')
    .addToUi();
}

function setupRosterSheet() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  let sh = ss.getSheetByName(SHEET_NAME);

  // 既にデータが入っていて列の並びが違う場合は、黙って上書きしない。
  // （見出しだけ差し替えると「役割」列が「作業者」列とみなされ、中身がずれるため）
  if (sh && sh.getLastRow() >= 2 && !headerMatches(sh)) {
    const res = ui.alert(
      '名簿を作り直しますか？',
      '今の「名簿」にはデータが入っていて、列の並びが新しい形（チェックボックス方式）と違います。\n\n' +
      '［はい］ 今のシートを「名簿_旧」として残し、新しい形の「名簿」を作り直します。\n' +
      '　　　　 従業員NO・氏名・PIN は手でコピーし、役割はチェックを付け直してください。\n\n' +
      '［いいえ］ 何もしません。今の形（「役割」列に文字で書く方式）のままでも動きます。\n' +
      '　　　　 兼務は「作業者・運転手」のように中黒でつないで書いてください。',
      ui.ButtonSet.YES_NO
    );
    if (res !== ui.Button.YES) return;

    sh.setName(backupSheetName(ss));
    sh = null;
  }

  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  sh.getRange(1, 1, 1, HEADERS.length)
    .setValues([HEADERS])
    .setFontWeight('bold')
    .setBackground('#1a1a1a')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center');

  const lastRow = sh.getMaxRows() - 1;

  // 従業員NO と PIN は「書式なしテキスト」にして先頭ゼロが消えないようにする
  sh.getRange(2, 1, lastRow, 1).setNumberFormat('@');   // 従業員NO
  sh.getRange(2, 3, lastRow, 1).setNumberFormat('@');   // PIN

  // 役割 3 列と在籍列をチェックボックスにする（4〜7 列目）
  sh.getRange(2, 4, lastRow, ROLE_LABELS.length + 1)
    .insertCheckboxes()
    .setHorizontalAlignment('center');

  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 110);  // 従業員NO
  sh.setColumnWidth(2, 140);  // 氏名
  sh.setColumnWidth(3, 90);   // PIN
  for (let c = 4; c <= 3 + ROLE_LABELS.length + 1; c++) sh.setColumnWidth(c, 72);

  // 見本が無ければ 1 行だけ入れる（作業者と運転手を兼ねる例）
  if (sh.getLastRow() < 2) {
    sh.getRange(2, 1, 1, HEADERS.length)
      .setValues([['W001', '山田太郎', '4728', true, true, false, true]]);
  }

  SpreadsheetApp.getUi().alert(
    '名簿シートを準備しました。\n\n' +
    '・従業員NO … 現場は W から、事務は A から（例：W001 / A001）\n' +
    '・PIN … 4桁の数字。管理者が割り振ってください\n' +
    '・作業者／運転手／管理者 … 該当するものすべてにチェック（兼務OK）\n' +
    '・在籍 … 退職したらチェックを外します（行は消さないでください）'
  );
}

// 見出し行が新しい形（チェックボックス方式）と一致するか
function headerMatches(sh) {
  const width = Math.max(sh.getLastColumn(), HEADERS.length);
  const head = sh.getRange(1, 1, 1, width).getDisplayValues()[0].map(s => String(s).trim());
  return HEADERS.every((h, i) => head[i] === h);
}

// 「名簿_旧」「名簿_旧2」… と空いている名前を探す
function backupSheetName(ss) {
  const base = SHEET_NAME + '_旧';
  if (!ss.getSheetByName(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!ss.getSheetByName(base + i)) return base + i;
  }
  return base + '_' + Utilities.formatDate(new Date(), 'JST', 'yyyyMMddHHmmss');
}

function generateRosterKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let key = '';
  for (let i = 0; i < 40; i++) key += chars.charAt(Math.floor(Math.random() * chars.length));
  PropertiesService.getScriptProperties().setProperty('ROSTER_KEY', key);
  SpreadsheetApp.getUi().alert(
    '合言葉(ROSTER_KEY)を作成し、スクリプト プロパティに保存しました。\n\n' +
    '同じ値を Cloudflare Worker の ROSTER_KEY にも登録してください：\n\n' + key
  );
}
