/**
 * 会場さがし 環境設定
 * GAS_URL を空にしておくと、初回アクセス時に画面の「設定」から入力できます。
 * 画面で保存したURLは LocalStorage に保存され、ここの値より優先されます。
 */
window.APP_CONFIG = {
  APP_NAME: '会場さがし',
  VERSION: 'v1.2.0',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzZwBHsLsDFW39fCvXl4qJ63y97Bc85Ial_7pRDu_fZByUEbdoNOrAc6BEs_ECl8Hrs/exec',
  MAX_COMPARE: 4,
  KEYS: {
    GAS_URL: 'kaijo_gas_url',
    TOKEN: 'kaijo_token',
    USER: 'kaijo_user',
    TUTORIAL_SEEN: 'kaijo_tutorial_seen',
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
  setGasUrl(url) {
    try {
      if (url) localStorage.setItem(APP_CONFIG.KEYS.GAS_URL, url.trim());
      else localStorage.removeItem(APP_CONFIG.KEYS.GAS_URL);
    } catch (e) { /* noop */ }
  },
};
