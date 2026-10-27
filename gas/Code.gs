/**
 * 会場くらべ（kaijo-kurabe） GAS バックエンド  v1.1.0
 * - doPost: JSON API（Content-Type: text/plain で受信 → CORSプリフライト回避）
 * - 認証: SHA-256 + salt + pepper（ストレッチング）、CacheService セッション
 * - 会場DB: スプレッドシート「Venues」シート
 * - AI: Gemini（条件抽出 / 雰囲気マッチ / TTS）
 * - Googleマップ: Places API (New) Text Search / Place Photos
 *
 * スクリプトプロパティ（setup() で一部自動作成）
 *   GEMINI_API_KEY   : 必須（手動で設定）
 *   PEPPER           : 自動生成（変更しないこと）
 *   GEMINI_MODEL     : 既定 gemini-2.5-flash
 *   TTS_MODEL        : 既定 gemini-2.5-flash-preview-tts
 *   TTS_VOICE        : 既定 Kore
 *   APP_URL          : 公開URL（メール本文に記載）
 *   TTS_FOLDER_ID    : 自動生成（音声キャッシュ用Driveフォルダ）
 *   GOOGLE_MAPS_API_KEY : Googleマップ検索用（Places API (New) を有効化したキー）
 */

const APP_NAME = '会場くらべ';
const APP_VERSION = 'v1.1.0';
const SESSION_TTL = 21600;          // 6時間（CacheService上限）
const MAX_FAIL = 5;                 // ログイン失敗ロック回数
const LOCK_MINUTES = 15;
const HASH_ROUNDS = 300;

const USER_HEADERS = ['email', 'name', 'salt', 'hash', 'mustChange', 'failCount', 'lockUntil', 'createdAt', 'agreedAt', 'lastLogin', 'status'];
const VENUE_HEADERS = ['id', 'active', 'name', 'operator', 'address', 'area', 'station', 'mapUrl',
  'budgetMin', 'budgetMax', 'planText', 'capacityMin', 'capacityMax', 'menu', 'catering',
  'atmosphere', 'tags', 'features', 'openHours', 'closedDays', 'phone', 'website',
  'imageIds', 'imageFolderId', 'videoUrl'];

/* =========================================================
 * エントリーポイント
 * ========================================================= */
function doGet() {
  return json_({ ok: true, app: APP_NAME, version: APP_VERSION });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(req.action || '');
    const publicActions = {
      ping: () => ({ app: APP_NAME, version: APP_VERSION }),
      register: () => register_(req),
      login: () => login_(req),
      forgot: () => forgot_(req),
    };
    const privateActions = {
      session: (u) => ({ user: publicUser_(u) }),
      logout: () => { CacheService.getScriptCache().remove('s_' + req.token); return {}; },
      changePassword: (u) => changePassword_(u, req),
      extract: () => extract_(req),
      search: () => search_(req),
      tts: () => tts_(req),
      placePhotos: () => placePhotos_(req),
    };
    if (publicActions[action]) return json_(Object.assign({ ok: true }, publicActions[action]()));
    if (privateActions[action]) {
      const user = requireUser_(req.token);
      if (user.mustChange && action !== 'changePassword' && action !== 'session' && action !== 'logout') {
        throw apiError_('パスワードの変更が必要です。', 'MUST_CHANGE');
      }
      return json_(Object.assign({ ok: true }, privateActions[action](user)));
    }
    throw apiError_('不明な操作です: ' + action);
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err), code: err.code || 'ERROR' });
  }
}

/* =========================================================
 * 初期セットアップ（エディタから一度だけ実行）
 * ========================================================= */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PEPPER')) props.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!props.getProperty('GEMINI_MODEL')) props.setProperty('GEMINI_MODEL', 'gemini-2.5-flash');
  if (!props.getProperty('TTS_MODEL')) props.setProperty('TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  if (!props.getProperty('TTS_VOICE')) props.setProperty('TTS_VOICE', 'Kore');
  if (!props.getProperty('TTS_FOLDER_ID')) {
    const folder = DriveApp.createFolder('kaijo-kurabe_tts_cache');
    props.setProperty('TTS_FOLDER_ID', folder.getId());
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let users = ss.getSheetByName('Users');
  if (!users) {
    users = ss.insertSheet('Users');
    users.appendRow(USER_HEADERS);
    users.setFrozenRows(1);
  }
  let venues = ss.getSheetByName('Venues');
  if (!venues) {
    venues = ss.insertSheet('Venues');
    venues.appendRow(VENUE_HEADERS);
    venues.setFrozenRows(1);
    sampleVenues_().forEach(r => venues.appendRow(VENUE_HEADERS.map(h => r[h] !== undefined ? r[h] : '')));
  }
  Logger.log('セットアップ完了。スクリプトプロパティ GEMINI_API_KEY を設定してください。');
}

function sampleVenues_() {
  return [
    { id: 'V001', active: true, name: 'ハーバーテラス（サンプル）', operator: 'サンプル企画株式会社', address: '神奈川県横浜市中区サンプル町1-2-3', area: '横浜', station: '桜木町駅 徒歩5分',
      budgetMin: 5000, budgetMax: 8000, planText: '立食パーティープラン 2時間飲み放題付き', capacityMin: 20, capacityMax: 80, menu: '地中海料理のビュッフェ、乾杯スパークリング', catering: '有',
      atmosphere: 'フォーマル, 夜景', tags: '貸切可, プロジェクター, マイク', features: '港を望む全面ガラスの会場。司会台とスクリーン完備。', openHours: '11:00-23:00', closedDays: '月' },
    { id: 'V002', active: true, name: '路地裏ダイニング灯（サンプル）', operator: '灯グループ', address: '神奈川県川崎市川崎区サンプル1-4-5', area: '川崎', station: '川崎駅 徒歩7分',
      budgetMin: 3500, budgetMax: 5000, planText: 'コース料理8品 + 2時間飲み放題', capacityMin: 8, capacityMax: 30, menu: '炭火焼き、季節の和惣菜', catering: '無',
      atmosphere: '隠れ家風, カジュアル', tags: '個室, 貸切可', features: '細い路地の奥にある古民家風ダイニング。半個室あり。', openHours: '17:00-24:00', closedDays: '日' },
    { id: 'V003', active: true, name: 'スタジオ・ノーツ（サンプル）', operator: 'ノーツ音響合同会社', address: '東京都渋谷区サンプル2-8-1', area: '渋谷', station: '渋谷駅 徒歩10分',
      budgetMin: 2500, budgetMax: 4500, planText: '会場貸切 3時間（音響・照明込み）', capacityMin: 30, capacityMax: 150, menu: 'ドリンクカウンター、ケータリング持込可', catering: '持込可',
      atmosphere: '音響設備重視, カジュアル', tags: 'PA, ステージ, 照明, 配信機材', features: 'ライブ・発表会向け。PA卓と配信用カメラを常設。', openHours: '10:00-22:00', closedDays: '' },
    { id: 'V004', active: true, name: '多摩川ガーデンハウス（サンプル）', operator: 'ガーデンハウス運営事務局', address: '神奈川県川崎市高津区サンプル3-3-3', area: '川崎', station: '二子新地駅 徒歩8分',
      budgetMin: 3000, budgetMax: 6000, planText: 'BBQ・ガーデンパーティープラン', capacityMin: 10, capacityMax: 60, menu: 'BBQセット、ソフトドリンク', catering: '有',
      atmosphere: 'カジュアル, 子連れOK, アウトドア', tags: '屋外, 駐車場, キッズスペース', features: '河川敷近くの一軒家と芝生の庭。雨天時は室内対応。', openHours: '10:00-21:00', closedDays: '火' },
  ];
}

/* =========================================================
 * 認証
 * ========================================================= */
function register_(req) {
  const email = normEmail_(req.email);
  const name = String(req.name || '').trim().slice(0, 60);
  const ag = req.agreements || {};
  if (!isEmail_(email)) throw apiError_('メールアドレスの形式が正しくありません。');
  if (!name) throw apiError_('氏名または組織名を入力してください。');
  if (!(ag.terms && ag.disclaimer && ag.selfResponsibility && ag.selfResolution)) {
    throw apiError_('すべての規約への同意が必要です。');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_('Users');
    if (findUserRow_(sh, email)) throw apiError_('このメールアドレスは既に登録されています。パスワードを忘れた場合は再発行してください。');
    const temp = tempPassword_();
    const salt = Utilities.getUuid();
    const now = new Date();
    sh.appendRow([email, name, salt, hash_(temp, salt), true, 0, '', now, now, '', 'active']);
    sendMail_(email, '【' + APP_NAME + '】会員登録完了と仮パスワードのお知らせ',
      name + ' 様\n\n' + APP_NAME + ' への会員登録が完了しました。\n\n' +
      '仮パスワード: ' + temp + '\n\n' +
      '初回ログイン時に新しいパスワードへの変更をお願いします。\n' + appUrlLine_() +
      '\n※本メールに心当たりがない場合は破棄してください。');
  } finally {
    lock.releaseLock();
  }
  return { message: '登録しました。仮パスワードをメールで送信しました。' };
}

function login_(req) {
  const email = normEmail_(req.email);
  const password = String(req.password || '');
  const sh = sheet_('Users');
  const found = findUserRow_(sh, email);
  const generic = 'メールアドレスまたはパスワードが正しくありません。';
  if (!found) throw apiError_(generic);
  const u = found.user;
  if (u.status !== 'active') throw apiError_('このアカウントは利用停止中です。');
  if (u.lockUntil && new Date(u.lockUntil) > new Date()) {
    throw apiError_('ログイン失敗が続いたため一時的にロックしています。' + LOCK_MINUTES + '分後に再度お試しください。');
  }
  if (hash_(password, u.salt) !== u.hash) {
    const fails = (Number(u.failCount) || 0) + 1;
    setUserFields_(sh, found.row, {
      failCount: fails >= MAX_FAIL ? 0 : fails,
      lockUntil: fails >= MAX_FAIL ? new Date(Date.now() + LOCK_MINUTES * 60000) : '',
    });
    throw apiError_(generic);
  }
  setUserFields_(sh, found.row, { failCount: 0, lockUntil: '', lastLogin: new Date() });
  const token = Utilities.getUuid() + '-' + Utilities.getUuid();
  CacheService.getScriptCache().put('s_' + token, email, SESSION_TTL);
  return { token: token, user: publicUser_(u) };
}

function changePassword_(user, req) {
  const current = String(req.currentPassword || '');
  const next = String(req.newPassword || '');
  if (hash_(current, user.salt) !== user.hash) throw apiError_('現在のパスワードが正しくありません。');
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(next)) throw apiError_('新しいパスワードは英字と数字を含む8文字以上にしてください。');
  if (next === current) throw apiError_('現在と異なるパスワードを設定してください。');
  const sh = sheet_('Users');
  const found = findUserRow_(sh, user.email);
  const salt = Utilities.getUuid();
  setUserFields_(sh, found.row, { salt: salt, hash: hash_(next, salt), mustChange: false });
  return { message: 'パスワードを変更しました。', user: Object.assign(publicUser_(user), { mustChange: false }) };
}

function forgot_(req) {
  const email = normEmail_(req.email);
  const msg = { message: '登録済みのアドレスであれば、新しい仮パスワードを送信しました。' };
  if (!isEmail_(email)) return msg;
  const sh = sheet_('Users');
  const found = findUserRow_(sh, email);
  if (!found || found.user.status !== 'active') return msg;
  const temp = tempPassword_();
  const salt = Utilities.getUuid();
  setUserFields_(sh, found.row, { salt: salt, hash: hash_(temp, salt), mustChange: true, failCount: 0, lockUntil: '' });
  sendMail_(email, '【' + APP_NAME + '】仮パスワード再発行のお知らせ',
    found.user.name + ' 様\n\n新しい仮パスワードを発行しました。\n\n仮パスワード: ' + temp +
    '\n\nログイン後、パスワードの変更をお願いします。\n' + appUrlLine_() +
    '\n※お心当たりがない場合も、以前のパスワードは無効になっています。上記の仮パスワードでログインし変更してください。');
  return msg;
}

function requireUser_(token) {
  if (!token) throw apiError_('ログインが必要です。', 'AUTH');
  const email = CacheService.getScriptCache().get('s_' + token);
  if (!email) throw apiError_('セッションの有効期限が切れました。再度ログインしてください。', 'AUTH');
  const found = findUserRow_(sheet_('Users'), email);
  if (!found || found.user.status !== 'active') throw apiError_('アカウントが無効です。', 'AUTH');
  CacheService.getScriptCache().put('s_' + token, email, SESSION_TTL); // スライディング延長
  return found.user;
}

function publicUser_(u) {
  return { email: u.email, name: u.name, mustChange: u.mustChange === true || u.mustChange === 'TRUE' };
}

/* =========================================================
 * Gemini：条件抽出
 * ========================================================= */
function extract_(req) {
  const text = String(req.text || '').trim().slice(0, 2000);
  if (!text) throw apiError_('条件の文章が空です。');
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd (E)');
  const prompt =
    'あなたはイベント会場検索の条件抽出器です。今日は ' + today + ' です。\n' +
    '次の発話から検索条件を抽出し、JSONのみを返してください。不明な項目は null。\n' +
    '- people: 人数（整数）\n- budget: 予算（円・整数）\n- budgetType: "perPerson"（1人あたり）または "total"（総額）\n' +
    '- date: 希望日 YYYY-MM-DD（「来週金曜」等は今日から計算）\n- timeFrom, timeTo: HH:MM（「夜」なら18:00-21:00程度）\n' +
    '- area: エリア・駅名\n- mood: 雰囲気・用途（短い日本語、読点区切り）\n\n発話:\n' + text;
  const res = callGemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          people: { type: 'INTEGER', nullable: true },
          budget: { type: 'INTEGER', nullable: true },
          budgetType: { type: 'STRING', nullable: true, enum: ['perPerson', 'total'] },
          date: { type: 'STRING', nullable: true },
          timeFrom: { type: 'STRING', nullable: true },
          timeTo: { type: 'STRING', nullable: true },
          area: { type: 'STRING', nullable: true },
          mood: { type: 'STRING', nullable: true },
        },
      },
      temperature: 0.1,
    },
  });
  return { criteria: parseJsonText_(geminiText_(res)) };
}

/* =========================================================
 * 会場検索（登録会場 ＋ Googleマップ）
 *   厳密モード（既定）：条件に1つでも合わない会場は除外
 *   req.relaxed === true：条件外も注意書き付きで返す
 *   req.source：'both'（既定） / 'db' / 'google'
 * ========================================================= */
function search_(req) {
  const c = req.criteria || {};
  const relaxed = req.relaxed === true;
  const source = ['db', 'google'].indexOf(req.source) >= 0 ? req.source : 'both';
  const people = toInt_(c.people);
  let perPerson = toInt_(c.budget);
  if (perPerson && c.budgetType === 'total' && people) perPerson = Math.floor(perPerson / people);
  if (c.budgetType === 'total' && !people) perPerson = null; // 人数不明の総額は比較不能

  const ctx = {
    people: people,
    perPerson: perPerson,
    area: String(c.area || '').trim(),
    mood: String(c.mood || '').trim(),
    date: c.date || '',
    weekday: c.date ? weekdayJa_(c.date) : '',
    weekdayIdx: c.date ? weekdayIdx_(c.date) : -1,
    timeFrom: String(c.timeFrom || ''),
    timeTo: String(c.timeTo || ''),
  };
  // エリア語：「新橋駅」「東京周辺」→「新橋」「東京」
  ctx.areaWords = ctx.area.split(/[\s,、・\/／]+/)
    .map(w => w.replace(/(駅|周辺|付近|近辺|近く|エリア|あたり)$/, ''))
    .filter(w => w.length >= 2);

  const reasons = { area: 0, capacity: 0, budget: 0, closed: 0, hours: 0, mood: 0 };
  let excluded = 0;
  const entries = [];
  const judge = (entry, fails) => {
    if (fails.length && !relaxed) {
      excluded++;
      fails.forEach(f => { reasons[f]++; });
      return;
    }
    entry.score -= fails.length * 20;
    entries.push(entry);
  };

  // ---- 登録会場 ----
  let dbTotal = 0;
  if (source !== 'google') {
    const all = readVenues_().filter(v => v.active);
    dbTotal = all.length;
    all.forEach(v => {
      const notes = [];
      const fails = [];
      let score = 50;
      if (ctx.areaWords.length) {
        const hay = [v.area, v.station, stripPrefecture_(v.address)].join(' ');
        if (ctx.areaWords.some(w => hay.indexOf(w) >= 0)) score += 15;
        else { fails.push('area'); notes.push('希望エリア外（' + (v.area || v.station || '所在地不明') + '）'); }
      }
      if (people) {
        if (v.capacityMax && people > v.capacityMax) { fails.push('capacity'); notes.push('収容人数オーバー（最大' + v.capacityMax + '名）'); }
        else if (v.capacityMin && people < v.capacityMin) { fails.push('capacity'); notes.push('人数に対して広すぎる（最少' + v.capacityMin + '名）'); }
        else score += 20;
      }
      if (perPerson && v.budgetMin) {
        if (perPerson >= v.budgetMin) score += 20;
        else { fails.push('budget'); notes.push('予算オーバー（最低' + v.budgetMin + '円/人）'); }
      }
      if (ctx.weekday && v.closedDays && v.closedDays.split(/[,、\s]+/).indexOf(ctx.weekday) >= 0) {
        fails.push('closed'); notes.push('希望日（' + ctx.weekday + '曜）は定休日');
      }
      if (v.openHours && ((ctx.timeFrom && !withinHours_(ctx.timeFrom, v.openHours)) ||
          (ctx.timeTo && !withinHours_(ctx.timeTo, v.openHours, true)))) {
        fails.push('hours'); notes.push('希望時間が営業時間外（' + v.openHours + '）');
      }
      judge({
        kind: 'db', v: v, score: score, notes: notes,
        moodItem: { id: v.id, name: v.name, atmosphere: v.atmosphere, tags: v.tags, features: v.features },
      }, fails);
    });
  }

  // ---- Googleマップ ----
  let googleTotal = 0;
  let googleError = '';
  if (source !== 'db') {
    try {
      const places = googleSearch_(ctx);
      googleTotal = places.length;
      places.forEach(p => {
        const r = judgePlace_(p, ctx);
        judge({
          kind: 'google', p: p, score: r.score, notes: r.notes,
          moodItem: { id: 'g:' + p.id, name: placeName_(p), atmosphere: (p.primaryTypeDisplayName || {}).text || '',
            tags: '', features: (p.editorialSummary || {}).text || '' },
        }, r.fails);
      });
    } catch (e) {
      googleError = e.message || String(e);
    }
  }

  // ---- 雰囲気（Gemini で採点、失敗時はキーワード一致） ----
  if (ctx.mood && entries.length) {
    let ai = null;
    try { ai = moodScores_(ctx.mood, entries.slice(0, 40).map(e => e.moodItem)); } catch (e) { ai = null; }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const a = ai && ai[e.moodItem.id];
      if (a) {
        e.aiComment = a.reason;
        if (a.score <= 3) {
          // 登録会場は情報が十分なので除外。Googleの会場は紹介文が乏しいため減点のみ
          if (!relaxed && e.kind === 'db') { entries.splice(i, 1); excluded++; reasons.mood++; continue; }
          e.notes.push('雰囲気・用途が合わない可能性');
        }
        e.score += (a.score - 5) * 3;
      } else {
        const hay = [e.moodItem.atmosphere, e.moodItem.tags, e.moodItem.features, e.moodItem.name].join(' ');
        if (ctx.mood.split(/[\s,、・]+/).some(w => w && hay.indexOf(w) >= 0)) e.score += 10;
      }
    }
  }

  entries.sort((a, b) => b.score - a.score);
  const photoMap = placeThumbs_(entries.slice(0, 30).filter(e => e.kind === 'google').map(e => e.p));
  const venues = entries.slice(0, 30).map(e => {
    const extra = {
      score: Math.max(0, Math.min(100, Math.round(e.score))),
      notes: e.notes,
      aiComment: e.aiComment || '',
    };
    return e.kind === 'db' ? toClientVenue_(e.v, extra) : Object.assign(placeToClient_(e.p, ctx, photoMap), extra);
  });

  return {
    venues: venues, total: dbTotal, googleTotal: googleTotal, googleError: googleError, source: source,
    excluded: excluded, reasons: reasons, relaxed: relaxed, perPerson: perPerson,
    mapsSearchUrl: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapsQuery_(ctx, ctx.areaWords[0] || ctx.area)),
  };
}

function stripPrefecture_(address) {
  return String(address || '').replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '');
}

/* =========================================================
 * Googleマップ（Places API (New)）
 *   スクリプトプロパティ GOOGLE_MAPS_API_KEY が必要
 * ========================================================= */
const PLACES_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.shortFormattedAddress',
  'places.rating', 'places.userRatingCount', 'places.priceLevel', 'places.priceRange',
  'places.googleMapsUri', 'places.websiteUri', 'places.nationalPhoneNumber',
  'places.regularOpeningHours', 'places.photos', 'places.primaryTypeDisplayName',
  'places.editorialSummary', 'places.goodForGroups', 'places.reservable', 'places.businessStatus',
].join(',');

function mapsKey_() {
  const key = prop_('GOOGLE_MAPS_API_KEY');
  if (!key) throw apiError_('Googleマップ検索のAPIキー（GOOGLE_MAPS_API_KEY）が未設定です。');
  return key;
}

function mapsQuery_(ctx, areaWord) {
  const moods = ctx.mood.split(/[\s,、・]+/).filter(Boolean).slice(0, 3).join(' ');
  return [areaWord, moods, ctx.people && ctx.people >= 10 ? '宴会' : '', moods ? '' : 'レストラン 会場']
    .filter(Boolean).join(' ').trim();
}

/** エリア語ごとに Text Search を並列実行し、重複を除いて返す */
function googleSearch_(ctx) {
  if (!ctx.areaWords.length) throw apiError_('Googleマップ検索にはエリア・駅を入力してください。');
  const key = mapsKey_();
  const cache = CacheService.getScriptCache();
  const words = ctx.areaWords.slice(0, 5);
  const perQuery = words.length > 2 ? 8 : 15;
  const queries = words.map(w => mapsQuery_(ctx, w));
  const results = new Array(queries.length);
  const todo = [];

  queries.forEach((q, i) => {
    const hit = cache.get('gq_' + md5_(q + '|' + perQuery));
    if (hit) results[i] = JSON.parse(hit);
    else todo.push(i);
  });

  if (todo.length) {
    const responses = UrlFetchApp.fetchAll(todo.map(i => ({
      url: 'https://places.googleapis.com/v1/places:searchText',
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS },
      payload: JSON.stringify({ textQuery: queries[i], languageCode: 'ja', regionCode: 'JP', pageSize: perQuery }),
      muteHttpExceptions: true,
    })));
    responses.forEach((res, k) => {
      const i = todo[k];
      let data = {};
      try { data = JSON.parse(res.getContentText()); } catch (e) { /* noop */ }
      if (res.getResponseCode() !== 200) {
        throw apiError_('Googleマップ検索エラー(' + res.getResponseCode() + '): ' + ((data.error && data.error.message) || ''));
      }
      results[i] = (data.places || []).map(p => Object.assign(p, { _areaWord: words[i] }));
      try { cache.put('gq_' + md5_(queries[i] + '|' + perQuery), JSON.stringify(results[i]), 3600); } catch (e) { /* 100KB超はキャッシュしない */ }
    });
  }

  const seen = {};
  const out = [];
  results.forEach(list => (list || []).forEach(p => {
    if (seen[p.id] || (p.businessStatus && p.businessStatus !== 'OPERATIONAL')) return;
    seen[p.id] = true;
    out.push(p);
  }));
  return out;
}

/** Googleの会場を条件で判定 */
function judgePlace_(p, ctx) {
  const notes = [];
  const fails = [];
  let score = 50;

  // 評価（最大 +20）
  if (p.rating) score += Math.round((Number(p.rating) - 3) * 10);

  // 人数（収容人数は取得できないため、団体可否のみ判定）
  if (ctx.people) {
    if (ctx.people >= 10 && p.goodForGroups === false) { fails.push('capacity'); notes.push('団体利用に不向き（Googleの情報）'); }
    else if (p.goodForGroups === true) { score += 10; notes.push('団体利用可。収容人数は要確認'); }
    else notes.push('収容人数は要確認');
  }

  // 予算（priceRange があれば判定）
  const range = priceRangeYen_(p);
  if (ctx.perPerson) {
    if (range.min) {
      if (ctx.perPerson >= range.min) score += 15;
      else { fails.push('budget'); notes.push('予算オーバー（目安' + range.min + '円〜/人）'); }
    } else notes.push('予算は要確認');
  }

  // 営業日時（regularOpeningHours.periods）
  const periods = (p.regularOpeningHours || {}).periods;
  if (ctx.weekdayIdx >= 0 && periods && periods.length) {
    const openThatDay = periods.some(pr => pr.open && pr.open.day === ctx.weekdayIdx) || periods.some(pr => !pr.close);
    if (!openThatDay) { fails.push('closed'); notes.push('希望日（' + ctx.weekday + '曜）は定休日'); }
    else if ((ctx.timeFrom && !placeOpenAt_(periods, ctx.weekdayIdx, toMin_(ctx.timeFrom))) ||
             (ctx.timeTo && !placeOpenAt_(periods, ctx.weekdayIdx, toMin_(ctx.timeTo) - 1))) {
      fails.push('hours'); notes.push('希望時間が営業時間外');
    }
  } else if (ctx.weekdayIdx >= 0) {
    notes.push('営業時間は要確認');
  }
  return { score: score, notes: notes, fails: fails };
}

function placeOpenAt_(periods, day, minutes) {
  if (minutes == null) return true;
  const WEEK = 7 * 1440;
  const t = day * 1440 + minutes;
  return periods.some(pr => {
    if (!pr.open) return false;
    if (!pr.close) return true; // 24時間営業
    const o = pr.open.day * 1440 + (pr.open.hour || 0) * 60 + (pr.open.minute || 0);
    let cl = pr.close.day * 1440 + (pr.close.hour || 0) * 60 + (pr.close.minute || 0);
    if (cl <= o) cl += WEEK;
    return (t >= o && t < cl) || (t + WEEK >= o && t + WEEK < cl);
  });
}

function priceRangeYen_(p) {
  const r = p.priceRange || {};
  const n = x => (x && x.units ? Number(x.units) : 0);
  return { min: n(r.startPrice), max: n(r.endPrice) };
}

function priceLevelText_(lv) {
  return ({
    PRICE_LEVEL_FREE: '無料', PRICE_LEVEL_INEXPENSIVE: '安い', PRICE_LEVEL_MODERATE: '手頃',
    PRICE_LEVEL_EXPENSIVE: 'やや高め', PRICE_LEVEL_VERY_EXPENSIVE: '高級',
  })[lv] || '';
}

function placeName_(p) { return (p.displayName || {}).text || '名称不明'; }

/** 検索結果の代表写真（1枚目）を並列取得：photoUri はキーを含まない */
function placeThumbs_(places) {
  const map = {};
  const targets = places.filter(p => p.photos && p.photos.length);
  if (!targets.length) return map;
  const cache = CacheService.getScriptCache();
  const need = [];
  targets.forEach(p => {
    const hit = cache.get('gp_' + md5_(p.photos[0].name));
    if (hit) map[p.id] = hit; else need.push(p);
  });
  if (need.length) {
    const key = mapsKey_();
    const res = UrlFetchApp.fetchAll(need.map(p => ({
      url: 'https://places.googleapis.com/v1/' + p.photos[0].name + '/media?maxWidthPx=800&skipHttpRedirect=true',
      headers: { 'X-Goog-Api-Key': key }, muteHttpExceptions: true,
    })));
    res.forEach((r, i) => {
      try {
        const uri = JSON.parse(r.getContentText()).photoUri;
        if (uri) { map[need[i].id] = uri; cache.put('gp_' + md5_(need[i].photos[0].name), uri, 3000); }
      } catch (e) { /* noop */ }
    });
  }
  return map;
}

function photoAttribution_(photo) {
  const a = (photo && photo.authorAttributions || [])[0] || {};
  return { attribution: a.displayName || '', attributionUri: a.uri || '' };
}

function placeToClient_(p, ctx, photoMap) {
  const range = priceRangeYen_(p);
  const hours = (p.regularOpeningHours || {}).weekdayDescriptions || [];
  // weekdayDescriptions は月曜始まり
  const dayLine = ctx.weekdayIdx >= 0 ? hours[(ctx.weekdayIdx + 6) % 7] || '' : '';
  const thumb = photoMap[p.id];
  return {
    id: 'g:' + p.id,
    placeId: p.id,
    source: 'google',
    name: placeName_(p),
    operator: '',
    address: p.formattedAddress || '',
    area: p._areaWord || '',
    station: p.shortFormattedAddress || '',
    mapUrl: p.googleMapsUri || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(placeName_(p))),
    budgetMin: range.min, budgetMax: range.max,
    planText: priceLevelText_(p.priceLevel) ? '価格帯：' + priceLevelText_(p.priceLevel) : '',
    capacityMin: 0, capacityMax: 0,
    menu: '',
    catering: '',
    atmosphere: (p.primaryTypeDisplayName || {}).text || '',
    tags: [p.goodForGroups ? '団体可' : '', p.reservable ? '予約可' : ''].filter(Boolean),
    features: (p.editorialSummary || {}).text || '',
    openHours: dayLine || hours.join(' / '),
    closedDays: '',
    phone: p.nationalPhoneNumber || '',
    website: p.websiteUri || '',
    rating: p.rating || 0,
    ratingCount: p.userRatingCount || 0,
    photoCount: (p.photos || []).length,
    images: thumb ? [Object.assign({ thumb: thumb, full: thumb }, photoAttribution_(p.photos[0]))] : [],
    video: null,
  };
}

/** 詳細表示用：写真を最大6枚取得 */
function placePhotos_(req) {
  const placeId = String(req.placeId || '').replace(/^g:/, '');
  if (!/^[\w-]+$/.test(placeId)) throw apiError_('会場IDが正しくありません。');
  const key = mapsKey_();
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places/' + placeId, {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'photos' }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw apiError_('写真を取得できませんでした。');
  const photos = (JSON.parse(res.getContentText()).photos || []).slice(0, 6);
  if (!photos.length) return { images: [] };
  const media = UrlFetchApp.fetchAll(photos.map(ph => ({
    url: 'https://places.googleapis.com/v1/' + ph.name + '/media?maxWidthPx=1400&skipHttpRedirect=true',
    headers: { 'X-Goog-Api-Key': key }, muteHttpExceptions: true,
  })));
  const images = [];
  media.forEach((r, i) => {
    try {
      const uri = JSON.parse(r.getContentText()).photoUri;
      if (uri) images.push(Object.assign({ thumb: uri, full: uri }, photoAttribution_(photos[i])));
    } catch (e) { /* noop */ }
  });
  return { images: images };
}

/** 音声ガイド用：Googleの会場情報から紹介文を作る */
function placeNarration_(placeId) {
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places/' + placeId, {
    headers: {
      'X-Goog-Api-Key': mapsKey_(),
      'X-Goog-FieldMask': 'displayName,shortFormattedAddress,formattedAddress,rating,userRatingCount,priceRange,priceLevel,primaryTypeDisplayName,editorialSummary,goodForGroups,reservable',
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw apiError_('会場情報を取得できませんでした。');
  const p = JSON.parse(res.getContentText());
  const s = [];
  const type = (p.primaryTypeDisplayName || {}).text;
  s.push(placeName_(p) + (type ? 'は、' + type + 'です。' : '。'));
  if (p.shortFormattedAddress || p.formattedAddress) s.push('場所は、' + stripPrefecture_(p.shortFormattedAddress || p.formattedAddress) + 'です。');
  if (p.rating) s.push('Googleマップでの評価は5点満点中' + p.rating + '点、口コミは' + (p.userRatingCount || 0) + '件です。');
  const range = priceRangeYen_(p);
  if (range.min) s.push('価格の目安は、お一人あたり' + range.min + '円' + (range.max ? 'から' + range.max + '円' : '') + 'です。');
  else if (priceLevelText_(p.priceLevel)) s.push('価格帯は' + priceLevelText_(p.priceLevel) + 'です。');
  if (p.goodForGroups) s.push('団体での利用に対応しています。');
  if (p.reservable) s.push('予約ができます。');
  if (p.editorialSummary && p.editorialSummary.text) s.push(endSentence_(p.editorialSummary.text));
  return s.join('');
}

function moodScores_(mood, venues) {
  if (!prop_('GEMINI_API_KEY')) return null;
  const items = venues.map(v => ({ id: v.id, name: v.name, atmosphere: v.atmosphere, tags: v.tags, features: v.features }));
  const prompt = '主催者の希望する雰囲気・用途:「' + mood + '」\n各会場の適合度を0〜10で採点し、理由を30字以内で書いてください。\n会場一覧:\n' + JSON.stringify(items);
  const res = callGemini_(prop_('GEMINI_MODEL', 'gemini-2.5-flash'), {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        id: { type: 'STRING' }, score: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['id', 'score', 'reason'] } },
      temperature: 0.2,
    },
  });
  const arr = parseJsonText_(geminiText_(res));
  const map = {};
  (arr || []).forEach(r => { map[r.id] = { score: Math.max(0, Math.min(10, Number(r.score) || 0)), reason: String(r.reason || '').slice(0, 40) }; });
  return map;
}

function readVenues_() {
  const values = sheet_('Venues').getDataRange().getValues();
  const head = values.shift().map(String);
  return values.filter(r => r[0] !== '').map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    ['budgetMin', 'budgetMax', 'capacityMin', 'capacityMax'].forEach(k => { o[k] = toInt_(o[k]) || 0; });
    o.active = o.active === true || String(o.active).toUpperCase() === 'TRUE';
    ['id', 'name', 'operator', 'address', 'area', 'station', 'mapUrl', 'planText', 'menu', 'catering', 'atmosphere',
      'tags', 'features', 'openHours', 'closedDays', 'phone', 'website', 'imageIds', 'imageFolderId', 'videoUrl']
      .forEach(k => { o[k] = String(o[k] == null ? '' : o[k]).trim(); });
    return o;
  });
}

function toClientVenue_(v, extra) {
  return Object.assign({
    id: v.id, name: v.name, operator: v.operator, address: v.address, area: v.area, station: v.station,
    mapUrl: v.mapUrl || ('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(v.address || v.name)),
    budgetMin: v.budgetMin, budgetMax: v.budgetMax, planText: v.planText,
    capacityMin: v.capacityMin, capacityMax: v.capacityMax, menu: v.menu, catering: v.catering,
    atmosphere: v.atmosphere, tags: splitList_(v.tags), features: v.features,
    openHours: v.openHours, closedDays: v.closedDays, phone: v.phone, website: v.website,
    images: venueImages_(v), video: parseVideo_(v.videoUrl),
  }, extra || {});
}

/* --- Drive 画像（ファイルは「リンクを知っている全員が閲覧可」に設定） --- */
function venueImages_(v) {
  let ids = splitList_(v.imageIds).map(driveId_).filter(Boolean);
  if (!ids.length && v.imageFolderId) {
    const cache = CacheService.getScriptCache();
    const key = 'img_' + v.imageFolderId;
    const hit = cache.get(key);
    if (hit) ids = JSON.parse(hit);
    else {
      try {
        const it = DriveApp.getFolderById(driveId_(v.imageFolderId)).getFiles();
        while (it.hasNext() && ids.length < 8) {
          const f = it.next();
          if (/^image\//.test(f.getMimeType())) ids.push(f.getId());
        }
        cache.put(key, JSON.stringify(ids), 21600);
      } catch (e) { ids = []; }
    }
  }
  return ids.slice(0, 8).map(id => ({
    thumb: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w640',
    full: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1600',
  }));
}

/* --- 映像（Google Earth Studio 書き出し動画） --- */
function parseVideo_(src) {
  src = String(src || '').trim();
  if (!src) return null;
  if (/\.(mp4|webm|mov)(\?|#|$)/i.test(src) && /^https:\/\//.test(src)) return { type: 'file', src: src };
  const yt = src.match(/(?:youtu\.be\/|v=|shorts\/)([\w-]{11})/);
  if (yt) return { type: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + yt[1] };
  const id = driveId_(src);
  if (id) return { type: 'drive', src: 'https://drive.google.com/file/d/' + id + '/preview' };
  return null;
}

function driveId_(s) {
  s = String(s || '').trim();
  const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/) || s.match(/folders\/([\w-]{20,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : '';
}

/* =========================================================
 * Gemini TTS 音声ガイド
 *   ・送信テキストは紹介文そのもののみ（メタ指示語を含めない）
 *   ・生成音声は Drive にキャッシュ（PCM 16bit）
 * ========================================================= */
function tts_(req) {
  const id = String(req.venueId || '');
  let raw;
  if (/^g:[\w-]+$/.test(id)) {
    raw = placeNarration_(id.slice(2));
  } else {
    const v = readVenues_().filter(x => x.id === id)[0];
    if (!v) throw apiError_('会場が見つかりません。');
    raw = buildNarration_(v);
  }
  const text = cleanNarration_(raw);
  if (!text) throw apiError_('読み上げる紹介文がありません。');

  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text + prop_('TTS_VOICE', 'Kore'), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('').slice(0, 16);
  const fileName = 'tts_' + id.replace(/[^\w-]/g, '_') + '_' + digest + '_24000.pcm';
  const folder = DriveApp.getFolderById(prop_('TTS_FOLDER_ID'));
  const exist = folder.getFilesByName(fileName);
  if (exist.hasNext()) {
    return { audio: Utilities.base64Encode(exist.next().getBlob().getBytes()), sampleRate: 24000, text: text, cached: true };
  }

  const res = callGemini_(prop_('TTS_MODEL', 'gemini-2.5-flash-preview-tts'), {
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prop_('TTS_VOICE', 'Kore') } } },
    },
  });
  const part = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  const inline = part.filter(p => p.inlineData)[0];
  if (!inline) throw apiError_('音声の生成に失敗しました。時間をおいて再度お試しください。');
  const rateMatch = String(inline.inlineData.mimeType || '').match(/rate=(\d+)/);
  const rate = rateMatch ? Number(rateMatch[1]) : 24000;
  const b64 = inline.inlineData.data;
  folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/octet-stream',
    fileName.replace('_24000', '_' + rate)));
  return { audio: b64, sampleRate: rate, text: text, cached: false };
}

function buildNarration_(v) {
  const s = [];
  s.push(v.name + (v.area ? 'は、' + v.area + 'にある会場です。' : '。'));
  if (v.station) s.push('アクセスは、' + v.station + 'です。');
  if (v.capacityMax) s.push((v.capacityMin ? v.capacityMin + '名から' : '') + v.capacityMax + '名まで利用できます。');
  if (v.budgetMin) s.push('予算の目安は、お一人あたり' + v.budgetMin + '円' + (v.budgetMax ? 'から' + v.budgetMax + '円' : '') + 'です。');
  if (v.planText) s.push(endSentence_(v.planText));
  if (v.menu) s.push('料理は、' + endSentence_(v.menu));
  if (v.features) s.push(endSentence_(v.features));
  return s.join('');
}

/** 読み上げテキストからメタ指示語・記号・URL を除去 */
function cleanNarration_(t) {
  return String(t || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(以下|次)の(文章?|テキスト|内容)を?[^。]{0,20}?(読み上げ|ナレーション|朗読|音読)[^。]*[。．.]?/g, '')
    .replace(/[^。]{0,20}(読み上げ|ナレーション|朗読|音読)(して|をして|て)?(ください|下さい|ほしい|願います)[。．.]?/g, '')
    .replace(/^(ナレーション|読み上げ|原稿|紹介文|テキスト)\s*[:：]\s*/gm, '')
    .replace(/[#*_`>|~\[\]{}「」『』【】]/g, '')
    .replace(/[（(][^）)]*サンプル[^）)]*[）)]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/。\s*。/g, '。')
    .trim()
    .slice(0, 900);
}

function endSentence_(t) {
  t = String(t).trim();
  return /[。！？!?]$/.test(t) ? t : t + '。';
}

/* =========================================================
 * ユーティリティ
 * ========================================================= */
function callGemini_(model, body) {
  const key = prop_('GEMINI_API_KEY');
  if (!key) throw apiError_('GEMINI_API_KEY が未設定です（GASのスクリプトプロパティ）。');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* noop */ }
  if (code !== 200) throw apiError_('Gemini APIエラー(' + code + '): ' + ((data.error && data.error.message) || ''));
  return data;
}

function geminiText_(res) {
  const parts = ((((res.candidates || [])[0] || {}).content) || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

function parseJsonText_(t) {
  const clean = String(t || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch (e) { throw apiError_('AIの応答を解析できませんでした。'); }
}

function hash_(password, salt) {
  let h = salt + ':' + password + ':' + prop_('PEPPER');
  for (let i = 0; i < HASH_ROUNDS; i++) {
    h = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8)
      .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  return h;
}

function tempPassword_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 9; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  if (!/[A-Za-z]/.test(s)) s = 'k' + s.slice(1);
  return s + '23456789'.charAt(Math.floor(Math.random() * 8)); // 英字＋数字を必ず含む10文字
}

function findUserRow_(sh, email) {
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).toLowerCase() === email) {
      const u = {};
      USER_HEADERS.forEach((h, j) => { u[h] = values[i][j]; });
      u.mustChange = u.mustChange === true || String(u.mustChange).toUpperCase() === 'TRUE';
      u.status = String(u.status || 'active');
      return { row: i + 1, user: u };
    }
  }
  return null;
}

function setUserFields_(sh, row, fields) {
  Object.keys(fields).forEach(k => {
    const col = USER_HEADERS.indexOf(k) + 1;
    if (col > 0) sh.getRange(row, col).setValue(fields[k]);
  });
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: APP_NAME });
}

function appUrlLine_() {
  const url = prop_('APP_URL');
  return url ? '\nログインページ: ' + url + '\n' : '';
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw apiError_('シート「' + name + '」がありません。setup() を実行してください。');
  return sh;
}

function prop_(k, def) { return PropertiesService.getScriptProperties().getProperty(k) || def || ''; }
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function isEmail_(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function toInt_(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; }
function splitList_(s) { return String(s || '').split(/[,、\n]+/).map(x => x.trim()).filter(Boolean); }

function weekdayJa_(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return ['日', '月', '火', '水', '木', '金', '土'][new Date(+m[1], +m[2] - 1, +m[3]).getDay()];
}

function withinHours_(hhmm, range, inclusiveEnd) {
  const toMin = s => { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
  const parts = String(range).split(/[-〜~]/);
  const start = toMin(parts[0]); let end = toMin(parts[1]); let t = toMin(hhmm);
  if (start == null || end == null || t == null) return true;
  if (end <= start) end += 1440;
  if (t < start) t += 1440;
  return t >= start && (inclusiveEnd ? t <= end : t < end);
}

function weekdayIdx_(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getDay() : -1;
}

function toMin_(hhmm) {
  const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

function md5_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

/** エディタから実行して Googleマップ検索の疎通を確認 */
function testGoogleMaps() {
  const ctx = { area: '新橋', areaWords: ['新橋'], mood: '個室', people: 8, perPerson: 6000,
    weekday: '金', weekdayIdx: 5, timeFrom: '19:00', timeTo: '21:00' };
  const places = googleSearch_(ctx);
  Logger.log(places.length + '件取得');
  places.slice(0, 5).forEach(p => Logger.log(placeName_(p) + ' / ' + p.formattedAddress + ' / ★' + (p.rating || '-')));
}

function apiError_(message, code) { const e = new Error(message); e.code = code || 'ERROR'; return e; }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
