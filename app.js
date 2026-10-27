/**
 * 会場さがし メインロジック
 * - 音声入力（Web Speech API 連続認識・沈黙で止まらない自動再開）
 * - Gemini による条件抽出 → フォーム反映
 * - 検索（登録会場＋Googleマップ）・並べ替え・カード表示・比較表・詳細（写真/Earth Studio映像）
 * - Gemini TTS 音声ガイド（PCM → WAV 変換して再生）
 * - 検索履歴（条件＋結果を自動保存、★保存・名前変更・削除、再表示・再検索）
 */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => (n ? '¥' + Number(n).toLocaleString('ja-JP') : '');
  const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');

  const state = {
    venues: [],
    selected: new Set(),
    sort: 'score',
    perPerson: null,
    searched: false,
    lastResult: null,
    currentSaved: null,   // 表示中の結果に対応する履歴 { id, title, createdAt, pinned }
    viewingSaved: false,  // 履歴から開いた結果を表示中か
    history: [],
    historyFilter: 'all',
    pickTimer: null,
    audioCache: new Map(),
    photoCache: new Map(),
    audio: null,
    playingId: null,
  };

  /* =========================================================
   * 起動
   * ========================================================= */
  document.addEventListener('DOMContentLoaded', () => {
    $('#appVersion').textContent = APP_CONFIG.VERSION;
    document.title = APP_CONFIG.APP_NAME;
    bindSettings();
    bindTutorial();
    bindSearch();
    bindVoice();
    bindResults();
    bindDialogs();
    bindHistory();
    bindImageFallback();

    if (!Config.getGasUrl()) openSettings(true);
    Auth.init();
  });

  document.addEventListener('auth:ready', () => {
    let seen = null;
    try { seen = localStorage.getItem(APP_CONFIG.KEYS.TUTORIAL_SEEN); } catch (e) { /* noop */ }
    if (!seen) $('#tutorialModal').showModal();
  });

  document.addEventListener('auth:logout', () => {
    state.venues = [];
    state.searched = false;
    state.lastResult = null;
    state.currentSaved = null;
    state.viewingSaved = false;
    state.history = [];
    $('#mapsNotice').hidden = true;
    renderSavedBanner();
    state.selected.clear();
    stopAudio();
    renderResults();
  });

  /* =========================================================
   * 設定（GAS URL）
   * ========================================================= */
  function bindSettings() {
    $('#settingsBtn').addEventListener('click', () => openSettings(false));
    $('#settingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const url = $('#gasUrlInput').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) {
        setFormMsg('#settingsMsg', 'GASのWebアプリURL（https://script.google.com/macros/s/…/exec）を入力してください。');
        return;
      }
      Config.setGasUrl(url);
      setFormMsg('#settingsMsg', '接続を確認しています…', 'info');
      try {
        const r = await Api.call('ping');
        setFormMsg('#settingsMsg', `接続できました（${r.app} ${r.version}）`, 'ok');
        setTimeout(() => { $('#settingsModal').close(); if (!Auth.user || !Auth.token()) Auth.init(); }, 700);
      } catch (err) {
        setFormMsg('#settingsMsg', err.message);
      }
    });
    $('#settingsReset').addEventListener('click', () => {
      Config.setGasUrl('');
      $('#gasUrlInput').value = APP_CONFIG.GAS_URL || '';
      setFormMsg('#settingsMsg', '保存したURLを削除しました。config.js の値に戻ります。', 'info');
    });
  }

  function openSettings(first) {
    $('#gasUrlInput').value = Config.getGasUrl();
    $('#settingsLead').textContent = first
      ? 'はじめに、バックエンド（Google Apps Script）のURLを登録してください。'
      : 'バックエンドの接続先を変更できます。保存したURLはこの端末にだけ記録されます。';
    setFormMsg('#settingsMsg', '');
    $('#settingsModal').showModal();
  }

  function setFormMsg(sel, text, type = 'error') {
    const el = $(sel);
    el.textContent = text;
    el.className = 'form-msg' + (text ? ' is-' + type : '');
  }

  /* =========================================================
   * 使い方ガイド
   * ========================================================= */
  function bindTutorial() {
    $('#helpBtn').addEventListener('click', () => $('#tutorialModal').showModal());
    $('#tutorialDone').addEventListener('click', () => {
      try { localStorage.setItem(APP_CONFIG.KEYS.TUTORIAL_SEEN, '1'); } catch (e) { /* noop */ }
      $('#tutorialModal').close();
    });
  }

  /* =========================================================
   * 検索フォーム
   * ========================================================= */
  function bindSearch() {
    $$('.mood-chip').forEach(chip => chip.addEventListener('click', () => {
      const input = $('#fMood');
      const words = input.value.split(/[、,\s]+/).filter(Boolean);
      const w = chip.dataset.word;
      const i = words.indexOf(w);
      if (i >= 0) words.splice(i, 1); else words.push(w);
      input.value = words.join('、');
      syncChips();
    }));
    $('#fMood').addEventListener('input', syncChips);

    $('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(false); });
    $('#emptyState').addEventListener('click', e => {
      if (e.target.closest('#relaxBtn')) runSearch(true);
    });
    $('#clearForm').addEventListener('click', () => {
      $('#searchForm').reset();
      syncChips();
    });
  }

  function syncChips() {
    const words = $('#fMood').value.split(/[、,\s]+/);
    $$('.mood-chip').forEach(c => c.setAttribute('aria-pressed', String(words.includes(c.dataset.word))));
  }

  function readCriteria() {
    const num = v => { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
    return {
      people: num($('#fPeople').value),
      budget: num($('#fBudget').value),
      budgetType: $('#fBudgetType').value,
      date: $('#fDate').value || null,
      timeFrom: $('#fTimeFrom').value || null,
      timeTo: $('#fTimeTo').value || null,
      area: $('#fArea').value.trim() || null,
      mood: $('#fMood').value.trim() || null,
    };
  }

  function applyCriteria(c) {
    const filled = [];
    const set = (sel, v, label) => { if (v !== null && v !== undefined && v !== '') { $(sel).value = v; filled.push(label); flash(sel); } };
    set('#fPeople', c.people, '人数');
    set('#fBudget', c.budget, '予算');
    if (c.budgetType) $('#fBudgetType').value = c.budgetType;
    if (c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date)) set('#fDate', c.date, '日付');
    if (c.timeFrom && /^\d{2}:\d{2}$/.test(c.timeFrom)) set('#fTimeFrom', c.timeFrom, '時間');
    if (c.timeTo && /^\d{2}:\d{2}$/.test(c.timeTo)) set('#fTimeTo', c.timeTo, '');
    set('#fArea', c.area, 'エリア');
    set('#fMood', c.mood, '雰囲気');
    syncChips();
    return filled.filter(Boolean);
  }

  function flash(sel) {
    const el = $(sel);
    el.classList.remove('is-filled');
    void el.offsetWidth;
    el.classList.add('is-filled');
  }

  const REASON_LABEL = { area: 'エリア', capacity: '人数', budget: '予算', closed: '定休日', hours: '営業時間', mood: '雰囲気・用途' };

  function summaryText(r, count) {
    const checked = (r.source !== 'google' ? r.total || 0 : 0) + (r.googleTotal || 0);
    const srcText = r.source === 'db' ? '登録会場' : r.source === 'google' ? 'Googleマップ' : '登録会場とGoogleマップ';
    return r.relaxed
      ? `条件をゆるめて表示しています（${count}件）。赤字の項目が条件と異なります。`
      : `${srcText}の ${checked}件のうち、条件に合う会場は ${count}件です` + (r.excluded ? `（除外 ${r.excluded}件）` : '');
  }

  function renderMapsNotice(r) {
    const box = $('#mapsNotice');
    const link = safeUrl(r.mapsSearchUrl);
    if (!link && !r.googleError) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML =
      (r.googleError ? `<p class="maps-err">Googleマップ検索：${esc(r.googleError)}</p>` : '') +
      (link ? `<a href="${esc(link)}" target="_blank" rel="noopener">Googleマップでこの条件の周辺を直接見る</a>` : '');
  }

  function reasonText(reasons) {
    return Object.keys(REASON_LABEL)
      .filter(k => reasons && reasons[k])
      .map(k => `${REASON_LABEL[k]}が合わない ${reasons[k]}件`)
      .join('、');
  }

  async function runSearch(relaxed) {
    if (!Auth.user) { Auth.open('login'); return; }
    const btn = $('#searchBtn');
    btn.disabled = true;
    btn.textContent = '探しています…';
    $('#results').setAttribute('aria-busy', 'true');
    try {
      const source = ($('input[name="source"]:checked') || {}).value || 'both';
      const r = await Api.call('search', { criteria: readCriteria(), relaxed: relaxed === true, source });
      state.venues = r.venues || [];
      state.perPerson = r.perPerson;
      state.searched = true;
      state.lastResult = r;
      state.viewingSaved = false;
      state.currentSaved = r.saved ? Object.assign({ pinned: false }, r.saved) : null;
      state.history = []; // 次に履歴を開いたとき再取得
      state.selected.forEach(id => { if (!state.venues.some(v => v.id === id)) state.selected.delete(id); });
      $('#resultSummary').textContent = summaryText(r, state.venues.length);
      renderMapsNotice(r);
      renderSavedBanner();
      renderResults();
      if (r.saveError) toast(r.saveError, 'error');
      if (state.selected.size) schedulePickedSync();
      if (window.matchMedia('(max-width: 900px)').matches) $('#results').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
      if (err.code !== 'AUTH' && err.code !== 'MUST_CHANGE') toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'この条件で探す';
      $('#results').removeAttribute('aria-busy');
    }
  }

  /* =========================================================
   * 音声入力（連続認識）
   *   continuous + interimResults。Chrome は沈黙で onend が来るため、
   *   ユーザーが「止める」を押すまで自動で再開する。
   * ========================================================= */
  const voice = { rec: null, listening: false, finalText: '', lastFinal: '', restartTimer: null };

  function bindVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const micBtn = $('#micBtn');
    if (!SR) {
      micBtn.disabled = true;
      $('#voiceHint').textContent = 'このブラウザは音声入力に対応していません。文章で入力して「条件に反映」を押してください。';
    }
    micBtn.addEventListener('click', () => (voice.listening ? stopVoice() : startVoice(SR)));
    $('#extractBtn').addEventListener('click', extractFromText);
    $('#voiceText').addEventListener('input', e => { voice.finalText = e.target.value; });
  }

  function startVoice(SR) {
    if (!SR) return;
    voice.finalText = $('#voiceText').value ? $('#voiceText').value.trim() + ' ' : '';
    voice.lastFinal = '';
    voice.listening = true;
    setMicUi(true);
    createAndStart(SR);
  }

  function createAndStart(SR) {
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) {
          // 一部 Android 端末の重複確定を除外
          if (t && t !== voice.lastFinal && !voice.finalText.endsWith(t)) {
            voice.finalText += t + ' ';
            voice.lastFinal = t;
          }
        } else {
          interim += t;
        }
      }
      $('#voiceText').value = (voice.finalText + interim).trimStart();
      $('#voiceInterim').textContent = interim ? '聞き取り中: ' + interim : '';
    };

    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        voice.listening = false;
        setMicUi(false);
        toast('マイクの使用が許可されていません。ブラウザの設定を確認してください。', 'error');
      } else if (e.error === 'audio-capture') {
        voice.listening = false;
        setMicUi(false);
        toast('マイクが見つかりません。', 'error');
      }
      // no-speech / aborted / network は onend で自動再開
    };

    rec.onend = () => {
      if (!voice.listening) return;
      clearTimeout(voice.restartTimer);
      voice.restartTimer = setTimeout(() => {
        if (!voice.listening) return;
        try { createAndStart(SR); } catch (err) { /* 次の onend で再試行 */ }
      }, 250);
    };

    voice.rec = rec;
    try { rec.start(); } catch (err) { /* 既に開始済み */ }
  }

  function stopVoice() {
    voice.listening = false;
    clearTimeout(voice.restartTimer);
    try { voice.rec && voice.rec.stop(); } catch (e) { /* noop */ }
    setMicUi(false);
    $('#voiceInterim').textContent = '';
    if ($('#voiceText').value.trim()) extractFromText();
  }

  function setMicUi(on) {
    const btn = $('#micBtn');
    btn.classList.toggle('is-live', on);
    btn.setAttribute('aria-pressed', String(on));
    $('#micLabel').textContent = on ? '止める' : '話して入力';
    $('#voiceHint').textContent = on
      ? '聞き取っています。途中で間が空いても大丈夫です。話し終えたら「止める」を押してください。'
      : '例：「来月の第2金曜、夜7時から30人くらい。川崎駅の近くで、ひとり5千円以内。落ち着いた雰囲気で音響があるところ」';
  }

  async function extractFromText() {
    const text = $('#voiceText').value.trim();
    if (!text) { toast('条件を話すか、文章で入力してください。'); return; }
    if (!Auth.user) { Auth.open('login'); return; }
    const btn = $('#extractBtn');
    btn.disabled = true;
    btn.textContent = 'AIが読み取り中…';
    try {
      const r = await Api.call('extract', { text });
      const filled = applyCriteria(r.criteria || {});
      toast(filled.length ? `${filled.join('・')}を反映しました。内容を確認して検索してください。` : '条件を読み取れませんでした。言い方を変えてお試しください。');
    } catch (err) {
      if (err.code !== 'AUTH') toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '条件に反映';
    }
  }

  /* =========================================================
   * 結果表示
   * ========================================================= */
  function bindResults() {
    $('#sortSelect').addEventListener('change', e => { state.sort = e.target.value; renderResults(); });

    $('#venueGrid').addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.closest('[data-id]').dataset.id;
      const act = btn.dataset.act;
      if (act === 'detail') openDetail(id);
      if (act === 'tts') playGuide(id, btn);
    });
    $('#venueGrid').addEventListener('change', e => {
      if (e.target.matches('.pick')) togglePick(e.target.closest('[data-id]').dataset.id, e.target);
    });

    $('#compareBtn').addEventListener('click', openCompare);
    $('#clearPick').addEventListener('click', () => { state.selected.clear(); renderResults(); schedulePickedSync(); });
    $('#tray').addEventListener('click', e => {
      const x = e.target.closest('[data-unpick]');
      if (x) { state.selected.delete(x.dataset.unpick); renderResults(); schedulePickedSync(); }
    });
  }

  function sorted() {
    const list = [...state.venues];
    const by = {
      score: (a, b) => b.score - a.score,
      budgetAsc: (a, b) => (a.budgetMin || 1e9) - (b.budgetMin || 1e9),
      capacityDesc: (a, b) => (b.capacityMax || 0) - (a.capacityMax || 0),
      name: (a, b) => a.name.localeCompare(b.name, 'ja'),
    };
    return list.sort(by[state.sort] || by.score);
  }

  function renderResults() {
    const grid = $('#venueGrid');
    const empty = $('#emptyState');
    if (!state.venues.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      $('#resultsBar').hidden = true;
      const r = state.lastResult;
      if (state.searched && r) {
        const why = reasonText(r.reasons);
        empty.innerHTML = `
          <h2>条件に合う会場が見つかりませんでした</h2>
          <p>${(r.source !== 'google' ? r.total : 0) + (r.googleTotal || 0)}件を確認しました。${why ? esc(why) + '。' : ''}</p>
          <p>エリアを広げる、人数や予算を見直すなどして、もう一度探してください。</p>
          ${!r.relaxed && ((r.source !== 'google' ? r.total : 0) + (r.googleTotal || 0)) ? '<p style="margin-top:1rem"><button type="button" class="btn-ghost" id="relaxBtn">条件をゆるめて近い会場を見る</button></p>' : ''}`;
      } else {
        empty.innerHTML = `
          <h2>条件を入れて「この条件で探す」を押してください</h2>
          <p>気になる会場の「比較」にチェックを入れると、画面下に集まります。2件以上で比較表を開けます（最大4件）。</p>`;
      }
    } else {
      empty.hidden = true;
      $('#resultsBar').hidden = false;
      grid.innerHTML = sorted().map(cardHtml).join('');
    }
    renderTray();
  }

  function budgetText(v) {
    if (!v.budgetMin && !v.budgetMax) return '要問い合わせ';
    return `${yen(v.budgetMin)}${v.budgetMax ? '〜' + yen(v.budgetMax).slice(1) : '〜'}`;
  }

  function capacityText(v) {
    if (!v.capacityMax) return '要問い合わせ';
    return `${v.capacityMin ? v.capacityMin + '〜' : '〜'}${v.capacityMax}名`;
  }

  function cardHtml(v) {
    const img = v.images && v.images[0];
    const picked = state.selected.has(v.id);
    const full = state.selected.size >= APP_CONFIG.MAX_COMPARE && !picked;
    return `
      <article class="venue" data-id="${esc(v.id)}">
        <div class="venue-media">
          ${img ? `<img src="${esc(img.thumb)}" alt="${esc(v.name)}の写真" loading="lazy" referrerpolicy="no-referrer">`
                : `<div class="venue-noimg" aria-hidden="true">${esc(v.name.slice(0, 1))}</div>`}
          <span class="src-badge ${v.source === 'google' ? 'is-google' : ''}">${v.source === 'google' ? 'Googleマップ' : '登録会場'}</span>
          ${v.video ? '<span class="venue-badge">空撮映像あり</span>' : ''}
          ${img && img.attribution ? `<span class="photo-credit">写真: ${esc(img.attribution)}</span>` : ''}
        </div>
        <div class="venue-body">
          <div class="venue-match" title="条件との一致度">
            <span class="match-bar"><span style="width:${Number(v.score) || 0}%"></span></span>
            <span class="match-num">一致度 ${Number(v.score) || 0}</span>
          </div>
          <h3 class="venue-name">${esc(v.name)}</h3>
          <p class="venue-where">${esc([v.area, v.station].filter(Boolean).join('／'))}</p>
          ${v.rating ? `<p class="venue-rating" aria-label="Googleマップの評価 ${v.rating}、口コミ${v.ratingCount}件">★ ${Number(v.rating).toFixed(1)}<span>（口コミ${Number(v.ratingCount).toLocaleString('ja-JP')}件）</span></p>` : ''}
          <dl class="venue-facts">
            <div><dt>予算/人</dt><dd>${esc(budgetText(v))}</dd></div>
            <div><dt>収容</dt><dd>${esc(capacityText(v))}</dd></div>
          </dl>
          ${v.aiComment ? `<p class="venue-ai">${esc(v.aiComment)}</p>` : ''}
          ${v.notes && v.notes.length ? `<ul class="venue-notes">${v.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
          ${v.tags && v.tags.length ? `<p class="venue-tags">${v.tags.slice(0, 5).map(t => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
        </div>
        <div class="venue-actions">
          <button type="button" class="btn-ghost" data-act="detail">詳細</button>
          <button type="button" class="btn-ghost tts-btn ${state.playingId === v.id ? 'is-playing' : ''}" data-act="tts" aria-label="${esc(v.name)}の音声ガイドを再生">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
            <span>${state.playingId === v.id ? '停止' : '音声ガイド'}</span>
          </button>
          <label class="pick-label ${full ? 'is-disabled' : ''}">
            <input type="checkbox" class="pick" ${picked ? 'checked' : ''} ${full ? 'disabled' : ''}>
            <span>比較</span>
          </label>
        </div>
      </article>`;
  }

  function togglePick(id, input) {
    if (input.checked) {
      if (state.selected.size >= APP_CONFIG.MAX_COMPARE) {
        input.checked = false;
        toast(`比較できるのは${APP_CONFIG.MAX_COMPARE}件までです。`);
        return;
      }
      state.selected.add(id);
    } else {
      state.selected.delete(id);
    }
    renderResults();
    schedulePickedSync();
  }

  function renderTray() {
    const tray = $('#tray');
    const n = state.selected.size;
    tray.hidden = n === 0;
    document.body.classList.toggle('has-tray', n > 0);
    const items = [...state.selected].map(id => state.venues.find(v => v.id === id)).filter(Boolean);
    $('#trayItems').innerHTML = items.map(v =>
      `<li><span>${esc(v.name)}</span><button type="button" data-unpick="${esc(v.id)}" aria-label="${esc(v.name)}を比較から外す">×</button></li>`).join('');
    $('#trayCount').textContent = `${n} / ${APP_CONFIG.MAX_COMPARE}`;
    $('#compareBtn').disabled = n < 2;
  }

  /* =========================================================
   * 比較表
   * ========================================================= */
  function openCompare() {
    const items = [...state.selected].map(id => state.venues.find(v => v.id === id)).filter(Boolean);
    if (items.length < 2) return;
    const minBudget = Math.min(...items.map(v => v.budgetMin || Infinity));
    const maxCap = Math.max(...items.map(v => v.capacityMax || 0));
    const rows = [
      ['写真', v => v.images && v.images[0]
        ? `<img class="cmp-img" src="${esc(v.images[0].thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="muted">なし</span>'],
      ['一致度', v => `<strong>${Number(v.score) || 0}</strong>`],
      ['情報元', v => (v.source === 'google' ? 'Googleマップ' : '登録会場')],
      ['Google評価', v => v.rating ? `★ ${Number(v.rating).toFixed(1)}（${Number(v.ratingCount).toLocaleString('ja-JP')}件）` : '<span class="muted">—</span>'],
      ['運営', v => esc(v.operator) || '<span class="muted">—</span>'],
      ['住所・アクセス', v => `${esc(v.address)}<br><span class="muted">${esc(v.station)}</span>`],
      ['予算/人', v => `<span class="${v.budgetMin && v.budgetMin === minBudget ? 'best' : ''}">${esc(budgetText(v))}</span>`],
      ['料金プラン', v => esc(v.planText) || '<span class="muted">—</span>'],
      ['収容人数', v => `<span class="${v.capacityMax && v.capacityMax === maxCap ? 'best' : ''}">${esc(capacityText(v))}</span>`],
      ['メニュー・飲食', v => esc(v.menu) || '<span class="muted">—</span>'],
      ['ケータリング', v => esc(v.catering) || '<span class="muted">—</span>'],
      ['雰囲気・特徴', v => `${esc(v.atmosphere)}<br>${esc(v.features)}`],
      ['営業時間', v => `${esc(v.openHours) || '—'}${v.closedDays ? `<br><span class="muted">定休 ${esc(v.closedDays)}</span>` : ''}`],
      ['AIコメント', v => esc(v.aiComment) || '<span class="muted">—</span>'],
      ['ロケーション映像', v => v.video ? `<button type="button" class="btn-ghost" data-cmp-video="${esc(v.id)}">映像を見る</button>` : '<span class="muted">なし</span>'],
      ['音声ガイド', v => `<button type="button" class="btn-ghost" data-cmp-tts="${esc(v.id)}">再生</button>`],
      ['地図', v => `<a href="${esc(safeUrl(v.mapUrl))}" target="_blank" rel="noopener">Googleマップで開く</a>`],
    ];
    $('#compareTable').innerHTML = `
      <thead><tr><th scope="col"><span class="sr-only">項目</span></th>${items.map(v => `<th scope="col">${esc(v.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, fn]) => `<tr><th scope="row">${label}</th>${items.map(v => `<td>${fn(v)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    $('#compareModal').showModal();
  }

  /* =========================================================
   * 詳細（写真ギャラリー・Earth Studio 映像）
   * ========================================================= */
  async function openDetail(id) {
    const v = state.venues.find(x => x.id === id);
    if (!v) return;
    const imgs = state.photoCache.get(id) || v.images || [];
    $('#detailTitle').textContent = v.name;
    $('#detailBody').innerHTML = `
      ${v.video ? `<section class="detail-video">${videoHtml(v.video, v.name)}</section>` : ''}
      ${imgs.length ? `
        <section class="gallery">
          <img id="galleryMain" src="${esc(imgs[0].full)}" alt="${esc(v.name)}の写真 1" referrerpolicy="no-referrer">
          <p class="gallery-credit" id="galleryCredit">${creditHtml(imgs[0])}</p>
          ${imgs.length > 1 ? `<div class="gallery-thumbs">${imgs.map((im, i) =>
            `<button type="button" data-full="${esc(im.full)}" data-n="${i + 1}" data-credit="${esc(creditHtml(im))}" aria-label="写真${i + 1}を表示"><img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}</div>` : ''}
        </section>` : ''}
      <dl class="detail-list">
        <div><dt>情報元</dt><dd>${v.source === 'google' ? 'Googleマップ' : '登録会場'}${v.rating ? `　★ ${Number(v.rating).toFixed(1)}（口コミ${Number(v.ratingCount).toLocaleString('ja-JP')}件）` : ''}</dd></div>
        ${v.operator ? `<div><dt>運営</dt><dd>${esc(v.operator)}</dd></div>` : ''}
        <div><dt>住所</dt><dd>${esc(v.address)}　<a href="${esc(safeUrl(v.mapUrl))}" target="_blank" rel="noopener">Googleマップで開く</a></dd></div>
        <div><dt>アクセス</dt><dd>${esc(v.station) || '—'}</dd></div>
        <div><dt>予算/人</dt><dd>${esc(budgetText(v))}</dd></div>
        <div><dt>料金プラン</dt><dd>${esc(v.planText) || '—'}</dd></div>
        <div><dt>収容人数</dt><dd>${esc(capacityText(v))}</dd></div>
        <div><dt>メニュー</dt><dd>${esc(v.menu) || '—'}</dd></div>
        <div><dt>ケータリング</dt><dd>${esc(v.catering) || '—'}</dd></div>
        <div><dt>雰囲気</dt><dd>${esc(v.atmosphere) || '—'}</dd></div>
        <div><dt>特徴</dt><dd>${esc(v.features) || '—'}</dd></div>
        <div><dt>営業時間</dt><dd>${esc(v.openHours) || '—'}${v.closedDays ? `（定休 ${esc(v.closedDays)}）` : ''}</dd></div>
        ${v.phone ? `<div><dt>電話</dt><dd><a href="tel:${esc(v.phone.replace(/[^\d+]/g, ''))}">${esc(v.phone)}</a></dd></div>` : ''}
        ${safeUrl(v.website) ? `<div><dt>Webサイト</dt><dd><a href="${esc(v.website)}" target="_blank" rel="noopener">公式サイトを開く</a></dd></div>` : ''}
      </dl>
      <p class="detail-note">${v.source === 'google' ? 'Googleマップの情報を表示しています。収容人数・貸切可否・' : ''}空き状況・最新の料金は会場へ直接ご確認ください。予約・契約は利用者と会場の間で行われます。</p>`;
    $('#detailTts').dataset.id = v.id;
    $('#detailModal').showModal();

    // Googleの会場は写真を追加取得（初回のみ）
    if (v.source === 'google' && v.photoCount > 1 && !state.photoCache.has(id)) {
      try {
        const r = await Api.call('placePhotos', { placeId: v.placeId });
        if (r.images && r.images.length) {
          state.photoCache.set(id, r.images);
          if ($('#detailModal').open && $('#detailTts').dataset.id === id) openDetail(id);
        }
      } catch (err) { /* 代表写真のみ表示 */ }
    }
  }

  function creditHtml(im) {
    if (!im || !im.attribution) return '';
    const uri = safeUrl(im.attributionUri);
    return '写真: ' + (uri ? `<a href="${esc(uri)}" target="_blank" rel="noopener">${esc(im.attribution)}</a>` : esc(im.attribution));
  }

  function videoHtml(video, name) {
    const src = esc(video.src);
    if (video.type === 'file') {
      return `<video src="${src}" controls playsinline preload="metadata" muted loop aria-label="${esc(name)}のロケーション映像"></video>`;
    }
    return `<div class="video-frame"><iframe src="${src}" title="${esc(name)}のロケーション映像" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  }

  /* =========================================================
   * 音声ガイド（Gemini TTS）
   * ========================================================= */
  async function playGuide(id, btn) {
    if (state.playingId === id) { stopAudio(); return; }
    stopAudio();
    const label = btn ? btn.querySelector('span') : null;
    if (label) label.textContent = '準備中…';
    if (btn) btn.disabled = true;
    try {
      let url = state.audioCache.get(id);
      if (!url) {
        const r = await Api.call('tts', { venueId: id });
        url = URL.createObjectURL(pcmToWav(r.audio, r.sampleRate || 24000));
        state.audioCache.set(id, url);
      }
      const audio = new Audio(url);
      state.audio = audio;
      state.playingId = id;
      audio.addEventListener('ended', stopAudio);
      await audio.play();
      refreshTtsButtons();
    } catch (err) {
      stopAudio();
      if (err.code !== 'AUTH') toast(err.message || '音声を再生できませんでした。', 'error');
    } finally {
      if (btn) btn.disabled = false;
      refreshTtsButtons();
    }
  }

  function stopAudio() {
    if (state.audio) { state.audio.pause(); state.audio = null; }
    state.playingId = null;
    refreshTtsButtons();
  }

  function refreshTtsButtons() {
    $$('#venueGrid .venue').forEach(card => {
      const b = card.querySelector('.tts-btn');
      const on = state.playingId === card.dataset.id;
      b.classList.toggle('is-playing', on);
      b.querySelector('span').textContent = on ? '停止' : '音声ガイド';
    });
    const d = $('#detailTts');
    if (d) d.textContent = state.playingId && state.playingId === d.dataset.id ? '音声ガイドを停止' : '音声ガイドを再生';
  }

  /** base64 PCM(16bit/mono) → WAV Blob */
  function pcmToWav(b64, rate) {
    const bin = atob(b64);
    const pcm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    const header = new ArrayBuffer(44);
    const dv = new DataView(header);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE');
    w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, pcm.length, true);
    return new Blob([header, pcm], { type: 'audio/wav' });
  }

  /* =========================================================
   * 検索履歴
   * ========================================================= */
  const fmtDate = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function criteriaChips(c) {
    const out = [];
    if (c.people) out.push(`${c.people}名`);
    if (c.budget) out.push(`${c.budgetType === 'total' ? '総額' : '1人'} ¥${Number(c.budget).toLocaleString('ja-JP')}`);
    if (c.date) out.push(c.date.replace(/-/g, '/'));
    if (c.timeFrom || c.timeTo) out.push(`${c.timeFrom || ''}〜${c.timeTo || ''}`);
    if (c.area) out.push(c.area);
    if (c.mood) out.push(c.mood);
    return out;
  }

  function bindHistory() {
    $('#historyBtn').addEventListener('click', openHistory);
    $$('#historyModal [data-hfilter]').forEach(b => b.addEventListener('click', () => {
      state.historyFilter = b.dataset.hfilter;
      $$('#historyModal [data-hfilter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      renderHistory();
    }));
    $('#historyList').addEventListener('click', async e => {
      const btn = e.target.closest('[data-hact]');
      if (!btn) return;
      const id = btn.closest('[data-hid]').dataset.hid;
      const act = btn.dataset.hact;
      if (act === 'open') openSaved(id);
      if (act === 'pin') togglePin(id);
      if (act === 'rename') renameSaved(id);
      if (act === 'delete') deleteSaved(id);
    });
    $('#savedBanner').addEventListener('click', e => {
      const b = e.target.closest('[data-bact]');
      if (!b || !state.currentSaved) return;
      if (b.dataset.bact === 'pin') togglePin(state.currentSaved.id);
      if (b.dataset.bact === 'rename') renameSaved(state.currentSaved.id);
      if (b.dataset.bact === 'research') runSearch(state.lastResult && state.lastResult.relaxed);
      if (b.dataset.bact === 'history') openHistory();
    });
  }

  async function openHistory() {
    if (!Auth.user) { Auth.open('login'); return; }
    $('#historyModal').showModal();
    if (state.history.length) { renderHistory(); return; }
    $('#historyList').innerHTML = '<p class="muted">読み込んでいます…</p>';
    try {
      const r = await Api.call('listSaved');
      state.history = r.items || [];
      renderHistory();
    } catch (err) {
      $('#historyList').innerHTML = `<p class="form-msg is-error">${esc(err.message)}</p>`;
    }
  }

  function renderHistory() {
    const list = state.history.filter(h => state.historyFilter === 'all' || h.pinned);
    if (!list.length) {
      $('#historyList').innerHTML = `<p class="muted">${state.historyFilter === 'pinned'
        ? '★を付けた検索はまだありません。残しておきたい検索に★を付けると、ここにまとまります。'
        : 'まだ検索履歴がありません。検索すると、条件と結果がここに自動で残ります。'}</p>`;
      return;
    }
    $('#historyList').innerHTML = list.map(h => `
      <article class="hist ${state.currentSaved && state.currentSaved.id === h.id ? 'is-current' : ''}" data-hid="${esc(h.id)}">
        <div class="hist-main">
          <h3>${h.pinned ? '<span class="hist-star" aria-label="★保存済み">★</span>' : ''}${esc(h.title)}</h3>
          <p class="hist-meta">${esc(fmtDate(h.createdAt))}　${h.count}件${h.picked && h.picked.length ? `　比較リスト ${h.picked.length}件` : ''}${h.relaxed ? '　条件ゆるめ' : ''}</p>
          <p class="hist-chips">${criteriaChips(h.criteria).map(c => `<span>${esc(c)}</span>`).join('')}</p>
        </div>
        <div class="hist-actions">
          <button type="button" class="btn" data-hact="open">開く</button>
          <button type="button" class="btn-ghost" data-hact="pin" aria-pressed="${h.pinned}">${h.pinned ? '★を外す' : '★保存'}</button>
          <button type="button" class="btn-ghost" data-hact="rename">名前変更</button>
          <button type="button" class="btn-ghost hist-del" data-hact="delete">削除</button>
        </div>
      </article>`).join('');
  }

  function setFormFromCriteria(c, source) {
    $('#searchForm').reset();
    const set = (sel, v) => { $(sel).value = v == null ? '' : v; };
    set('#fPeople', c.people);
    set('#fBudget', c.budget);
    $('#fBudgetType').value = c.budgetType === 'total' ? 'total' : 'perPerson';
    set('#fDate', c.date);
    set('#fTimeFrom', c.timeFrom);
    set('#fTimeTo', c.timeTo);
    set('#fArea', c.area);
    set('#fMood', c.mood);
    const radio = $(`input[name="source"][value="${source || 'both'}"]`);
    if (radio) radio.checked = true;
    syncChips();
  }

  async function openSaved(id) {
    const btn = $(`#historyList [data-hid="${CSS.escape(id)}"] [data-hact="open"]`);
    if (btn) { btn.disabled = true; btn.textContent = '開いています…'; }
    try {
      const r = await Api.call('getSaved', { id });
      stopAudio();
      setFormFromCriteria(r.item.criteria || {}, r.item.source);
      state.venues = r.venues || [];
      state.lastResult = Object.assign({}, r.summary, { venues: state.venues });
      state.perPerson = r.summary.perPerson;
      state.searched = true;
      state.viewingSaved = true;
      state.currentSaved = r.item;
      state.selected = new Set((r.item.picked || []).filter(pid => state.venues.some(v => v.id === pid)));
      $('#resultSummary').textContent = summaryText(r.summary, state.venues.length);
      renderMapsNotice(r.summary);
      renderSavedBanner();
      renderResults();
      $('#historyModal').close();
      $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '開く'; }
    }
  }

  async function updateSaved(id, patch) {
    const r = await Api.call('updateSaved', Object.assign({ id }, patch));
    const i = state.history.findIndex(h => h.id === id);
    if (i >= 0) state.history[i] = r.item;
    if (state.currentSaved && state.currentSaved.id === id) state.currentSaved = Object.assign({}, state.currentSaved, r.item);
    return r.item;
  }

  async function togglePin(id) {
    const cur = state.history.find(h => h.id === id) || (state.currentSaved && state.currentSaved.id === id ? state.currentSaved : null);
    const next = !(cur && cur.pinned);
    try {
      await updateSaved(id, { pinned: next });
      toast(next ? '★保存しました。履歴の上限を超えても消えません。' : '★を外しました。');
      renderHistory();
      renderSavedBanner();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function renameSaved(id) {
    const cur = state.history.find(h => h.id === id) || state.currentSaved;
    const title = window.prompt('この検索の名前', cur ? cur.title : '');
    if (title == null) return;
    try {
      await updateSaved(id, { title });
      toast('名前を変更しました。');
      renderHistory();
      renderSavedBanner();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteSaved(id) {
    const cur = state.history.find(h => h.id === id);
    if (!window.confirm(`「${cur ? cur.title : 'この検索'}」を履歴から削除しますか？`)) return;
    try {
      await Api.call('deleteSaved', { id });
      state.history = state.history.filter(h => h.id !== id);
      if (state.currentSaved && state.currentSaved.id === id) { state.currentSaved = null; renderSavedBanner(); }
      renderHistory();
      toast('削除しました。');
    } catch (err) { toast(err.message, 'error'); }
  }

  /** 比較リストの選択を履歴に保存（連続操作はまとめて送信） */
  function schedulePickedSync() {
    if (!state.currentSaved) return;
    clearTimeout(state.pickTimer);
    const id = state.currentSaved.id;
    state.pickTimer = setTimeout(() => {
      updateSaved(id, { picked: [...state.selected] }).catch(() => { /* 次回操作時に再送 */ });
    }, 900);
  }

  function renderSavedBanner() {
    const box = $('#savedBanner');
    const cur = state.currentSaved;
    if (!cur) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('is-old', state.viewingSaved);
    box.innerHTML = state.viewingSaved
      ? `<p><strong>${cur.pinned ? '★ ' : ''}${esc(cur.title)}</strong><br>
           <span class="muted">${esc(fmtDate(cur.createdAt))} に保存した検索結果です。料金・営業時間・写真は保存時点の情報です。</span></p>
         <div class="banner-actions">
           <button type="button" class="btn-ghost" data-bact="research">この条件で最新の情報を検索</button>
           <button type="button" class="btn-ghost" data-bact="pin">${cur.pinned ? '★を外す' : '★保存'}</button>
           <button type="button" class="btn-ghost" data-bact="history">履歴一覧</button>
         </div>`
      : `<p>条件と結果を履歴に保存しました：<strong>${cur.pinned ? '★ ' : ''}${esc(cur.title)}</strong></p>
         <div class="banner-actions">
           <button type="button" class="btn-ghost" data-bact="pin">${cur.pinned ? '★を外す' : '★保存'}</button>
           <button type="button" class="btn-ghost" data-bact="rename">名前変更</button>
         </div>`;
  }

  /** 保存時の写真URLが期限切れの場合は頭文字表示に切り替える */
  function bindImageFallback() {
    document.addEventListener('error', e => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      const media = img.closest('.venue-media');
      if (media) {
        const name = (img.closest('.venue').querySelector('.venue-name') || {}).textContent || '';
        img.replaceWith(Object.assign(document.createElement('div'), { className: 'venue-noimg', textContent: name.slice(0, 1) }));
      } else if (img.closest('.cmp, .gallery')) {
        img.hidden = true;
      }
    }, true);
  }

  /* =========================================================
   * ダイアログ共通
   * ========================================================= */
  function bindDialogs() {
    $$('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    // 背景クリックで閉じる（認証モーダル以外）
    $$('dialog:not(#authModal)').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

    // 詳細：ギャラリー切替・音声
    $('#detailBody').addEventListener('click', e => {
      const t = e.target.closest('[data-full]');
      if (t) {
        const m = $('#galleryMain');
        m.src = t.dataset.full;
        m.alt = `写真 ${t.dataset.n}`;
        const cr = $('#galleryCredit');
        if (cr) cr.innerHTML = t.dataset.credit || '';
      }
    });
    $('#detailTts').addEventListener('click', e => playGuide(e.currentTarget.dataset.id, null));
    $('#detailModal').addEventListener('close', () => { $('#detailBody').innerHTML = ''; });

    // 比較表：映像・音声
    $('#compareTable').addEventListener('click', e => {
      const vb = e.target.closest('[data-cmp-video]');
      if (vb) {
        const v = state.venues.find(x => x.id === vb.dataset.cmpVideo);
        if (v && v.video) vb.outerHTML = videoHtml(v.video, v.name);
      }
      const tb = e.target.closest('[data-cmp-tts]');
      if (tb) playGuide(tb.dataset.cmpTts, null);
    });
    $('#compareModal').addEventListener('close', () => stopAudio());
  }
})();
