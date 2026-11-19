/**
 * 会場さがし 環境設定
 * GAS_URL を空にしておくと、初回アクセス時に画面の「設定」から入力できます。
 * 画面で保存したURLは LocalStorage に保存され、ここの値より優先されます。
 */
window.APP_CONFIG = {
  APP_NAME: '会場さがし',
  VERSION: 'v1.4.0',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzZwBHsLsDFW39fCvXl4qJ63y97Bc85Ial_7pRDu_fZByUEbdoNOrAc6BEs_ECl8Hrs/exec',
  MAX_COMPARE: 4,

  // 既定のGeminiモデル（ユーザーが画面で選んでいない時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「AIモデル」の選択肢（value がAPIのモデルID）
  // 指定モデルに該当がない（廃止・未公開・名前違い）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' },
  ],

  KEYS: {
    GAS_URL: 'kaijo_gas_url',
    TOKEN: 'kaijo_token',
    USER: 'kaijo_user',
    TUTORIAL_SEEN: 'kaijo_tutorial_seen',
    MODEL: 'kaijo_gemini_model',
  },
};

window.Config = {
  getGasUrl() {
    try {
      return (localStorage.getItem(APP_CONFIG.KEYS.GAS_URL) || APP_CONFIG.GAS_URL || '').trim();
    } catch (e) {
      return (APP_CONFIG.GAS_URL || '').trim();
    }
  },
  /** 選択中のGeminiモデル（'' = 自動） */
  getModel() {
    const opts = APP_CONFIG.GEMINI_MODEL_OPTIONS || [];
    let saved = null;
    try { saved = localStorage.getItem(APP_CONFIG.KEYS.MODEL); } catch (e) { /* noop */ }
    if (saved !== null && opts.some(o => o.value === saved)) return saved;
    return APP_CONFIG.GEMINI_MODEL || '';
  },
  setModel(model) {
    try { localStorage.setItem(APP_CONFIG.KEYS.MODEL, model || ''); } catch (e) { /* noop */ }
  },
  modelLabel(value) {
    const opts = APP_CONFIG.GEMINI_MODEL_OPTIONS || [];
    const o = opts.find(x => x.value === value);
    return o ? o.label : (value || '自動モード（汎用の最新）');
  },
  setGasUrl(url) {
    try {
      if (url) localStorage.setItem(APP_CONFIG.KEYS.GAS_URL, url.trim());
      else localStorage.removeItem(APP_CONFIG.KEYS.GAS_URL);
    } catch (e) { /* noop */ }
  },
};
