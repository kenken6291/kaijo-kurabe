/**
 * 会場さがし 認証・API通信
 * - Api.call(action, data) : GAS への POST（text/plain でCORS回避）
 * - 会員登録（規約同意必須）/ ログイン / 初回パスワード変更強制 / 仮パスワード再発行
 * - パスワード表示切替
 */
(() => {
  const K = APP_CONFIG.KEYS;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------------- API ---------------- */
  const Api = {
    async call(action, data = {}) {
      const url = Config.getGasUrl();
      if (!url) {
        const err = new Error('GASのURLが未設定です。右上の「設定」から登録してください。');
        err.code = 'NO_URL';
        throw err;
      }
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action, token: Auth.token(), ...data }),
          redirect: 'follow',
        });
      } catch (e) {
        throw new Error('サーバーに接続できません。GASのURLと公開設定（全員）を確認してください。');
      }
      let json;
      try { json = await res.json(); } catch (e) { throw new Error('サーバーの応答を読み取れません。GASのURLが正しいか確認してください。'); }
      if (!json.ok) {
        const err = new Error(json.error || 'エラーが発生しました。');
        err.code = json.code;
        if (json.code === 'AUTH') Auth.expire(err.message);
        if (json.code === 'MUST_CHANGE') Auth.open('change');
        throw err;
      }
      return json;
    },
  };

  /* ---------------- 状態 ---------------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* noop */ } },
  };

  const Auth = {
    user: null,
    token() { return store.get(K.TOKEN) || ''; },

    async init() {
      if (!this._bound) { bindUi(); this._bound = true; }
      const cached = store.get(K.USER);
      if (cached) { try { this.user = JSON.parse(cached); } catch (e) { this.user = null; } }
      if (!Config.getGasUrl()) return; // 設定待ち（app.js が設定モーダルを開く）
      if (!this.token()) { this.open('login'); return; }
      try {
        const r = await Api.call('session');
        this.setUser(r.user);
        if (r.user.mustChange) this.open('change'); else this.ready();
      } catch (e) {
        if (e.code !== 'AUTH') { toast(e.message, 'error'); this.open('login'); }
      }
    },

    setUser(u) {
      this.user = u;
      store.set(K.USER, u ? JSON.stringify(u) : null);
      $('#userName').textContent = u ? u.name : '';
      document.body.classList.toggle('is-auth', !!u);
    },

    ready() {
      close();
      document.dispatchEvent(new CustomEvent('auth:ready', { detail: this.user }));
    },

    expire(msg) {
      store.set(K.TOKEN, null);
      this.setUser(null);
      this.open('login', msg);
    },

    async logout() {
      try { await Api.call('logout'); } catch (e) { /* noop */ }
      store.set(K.TOKEN, null);
      this.setUser(null);
      document.dispatchEvent(new CustomEvent('auth:logout'));
      this.open('login', 'ログアウトしました。');
    },

    open(view, msg) {
      const dlg = $('#authModal');
      $$('[data-view]', dlg).forEach(s => { s.hidden = s.dataset.view !== view; });
      dlg.dataset.current = view;
      // パスワード変更の強制時は閉じられない
      $('#authClose').hidden = !(view === 'change' && this.user && !this.user.mustChange);
      $$('[data-msg]', dlg).forEach(m => { m.textContent = ''; m.className = 'form-msg'; });
      if (msg) setMsg(view, msg, 'info');
      if (!dlg.open) dlg.showModal();
      const first = $(`[data-view="${view}"] input`, dlg);
      if (first) setTimeout(() => first.focus(), 50);
    },
  };

  function close() {
    const dlg = $('#authModal');
    if (dlg.open) dlg.close();
  }

  function setMsg(view, text, type = 'error') {
    const el = $(`[data-view="${view}"] [data-msg]`);
    if (el) { el.textContent = text; el.className = 'form-msg is-' + type; }
  }

  async function withBusy(btn, fn) {
    if (btn.disabled) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '処理中…';
    try { await fn(); } finally { btn.disabled = false; btn.textContent = label; refreshRegisterBtn(); }
  }

  function refreshRegisterBtn() {
    const all = $$('#authModal .agree').every(c => c.checked);
    const btn = $('#registerBtn');
    if (btn && btn.textContent !== '処理中…') btn.disabled = !all;
  }

  /* ---------------- UI ---------------- */
  function bindUi() {
    const dlg = $('#authModal');

    // Esc で閉じない（ログイン必須）
    dlg.addEventListener('cancel', e => {
      if (!(dlg.dataset.current === 'change' && Auth.user && !Auth.user.mustChange)) e.preventDefault();
    });
    $('#authClose').addEventListener('click', close);

    $$('[data-go]', dlg).forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      Auth.open(a.dataset.go);
    }));

    // パスワード表示切替
    $$('.pw-toggle').forEach(btn => btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'パスワードを隠す' : 'パスワードを表示');
      btn.classList.toggle('is-on', show);
    }));

    // 規約同意 → 登録ボタン活性
    $$('#authModal .agree').forEach(c => c.addEventListener('change', refreshRegisterBtn));
    refreshRegisterBtn();
    $('#openTerms').addEventListener('click', e => { e.preventDefault(); $('#termsModal').showModal(); });

    // ログイン
    $('#loginForm').addEventListener('submit', e => {
      e.preventDefault();
      const btn = $('#loginBtn');
      withBusy(btn, async () => {
        try {
          const r = await Api.call('login', { email: $('#loginEmail').value, password: $('#loginPassword').value });
          store.set(K.TOKEN, r.token);
          Auth.setUser(r.user);
          $('#loginPassword').value = '';
          if (r.user.mustChange) Auth.open('change', '初回ログインです。新しいパスワードを設定してください。');
          else { Auth.ready(); toast(`${r.user.name} さん、ようこそ`); }
        } catch (err) { setMsg('login', err.message); }
      });
    });

    // 新規登録
    $('#registerForm').addEventListener('submit', e => {
      e.preventDefault();
      const btn = $('#registerBtn');
      const agreements = {};
      $$('#authModal .agree').forEach(c => { agreements[c.dataset.key] = c.checked; });
      if (!Object.values(agreements).every(Boolean)) { setMsg('register', 'すべての項目に同意してください。'); return; }
      withBusy(btn, async () => {
        try {
          const email = $('#regEmail').value;
          const r = await Api.call('register', { email, name: $('#regName').value, agreements });
          $('#registerForm').reset();
          Auth.open('login', r.message + ' メールに記載の仮パスワードでログインしてください。');
          $('#loginEmail').value = email;
        } catch (err) { setMsg('register', err.message); }
      });
    });

    // パスワード再発行
    $('#forgotForm').addEventListener('submit', e => {
      e.preventDefault();
      const btn = $('#forgotBtn');
      withBusy(btn, async () => {
        try {
          const email = $('#forgotEmail').value;
          const r = await Api.call('forgot', { email });
          Auth.open('login', r.message);
          $('#loginEmail').value = email;
        } catch (err) { setMsg('forgot', err.message); }
      });
    });

    // パスワード変更
    $('#changeForm').addEventListener('submit', e => {
      e.preventDefault();
      const next = $('#newPassword').value;
      if (next !== $('#newPassword2').value) { setMsg('change', '新しいパスワード（確認）が一致しません。'); return; }
      if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(next)) { setMsg('change', '英字と数字を含む8文字以上にしてください。'); return; }
      const btn = $('#changeBtn');
      withBusy(btn, async () => {
        try {
          const r = await Api.call('changePassword', { currentPassword: $('#curPassword').value, newPassword: next });
          $('#changeForm').reset();
          Auth.setUser(r.user);
          toast(r.message);
          Auth.ready();
        } catch (err) { setMsg('change', err.message); }
      });
    });

    $('#logoutBtn').addEventListener('click', () => Auth.logout());
    $('#changePwBtn').addEventListener('click', () => Auth.open('change'));
  }

  /* ---------------- トースト（共通） ---------------- */
  function toast(text, type = 'info') {
    const box = $('#toast');
    const el = document.createElement('div');
    el.className = 'toast-item is-' + type;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
  }

  window.Api = Api;
  window.Auth = Auth;
  window.toast = toast;
})();
