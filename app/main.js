import { loadSaved, saveSaved, loadBreakdowns, saveBreakdowns, loadQuestions, saveQuestions } from './storage.js';
import { Sync } from './sync.js';

const $ = id => document.getElementById(id);

const ASK_URL = 'http://127.0.0.1:8045/api/ask';
const TTS_URL = 'http://127.0.0.1:8045/api/tts';
const BREAKDOWN_URL = 'http://127.0.0.1:8045/api/breakdown';
const QUESTION_URL = 'http://127.0.0.1:8045/api/question';

const breakdownCache = new Map(Object.entries(loadBreakdowns())); // text -> { words: [...] }
const breakdownLoading = new Set();
const breakdownOpen = new Set();

function persistBreakdowns() {
  saveBreakdowns(Object.fromEntries(breakdownCache));
}

// per Spanish text → array of { q, a, askedAt }
const questionsByText = new Map(Object.entries(loadQuestions()));
const questionsOpen = new Set();
const questionsLoading = new Set();

function persistQuestions() {
  saveQuestions(Object.fromEntries(questionsByText));
}

function getQuestions(text) {
  return questionsByText.get(text) || [];
}

const PLACEHOLDERS = {
  en2es: 'what do I say in Spanish when…',
  es2en: 'what does this Spanish word or phrase mean…'
};

const input = $('ask-input');
const status = $('ask-status');
const listEl = $('list');
const pendingEl = $('pending');

const saved = loadSaved();
let pending = null;
let mode = 'en2es';
let filterText = '';
let filterTag = 'all';
let selectedSavedId = null;

function matchesFilter(p, q) {
  if (filterTag !== 'all' && p.tag !== filterTag) return false;
  if (!q) return true;
  const hay = [p.intent, p.es, p.en, p.literal, p.tag].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

function renderFilterTags() {
  const counts = new Map();
  for (const p of saved) {
    counts.set(p.tag, (counts.get(p.tag) || 0) + 1);
  }
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const el = $('filter-tags');
  el.innerHTML = `
    <button class="filter-tag ${filterTag === 'all' ? 'active' : ''}" data-tag="all">
      all <span class="filter-tag-count">${saved.length}</span>
    </button>
    ${tags.map(([tag, n]) => `
      <button class="filter-tag ${filterTag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">
        ${escapeHtml(tag)} <span class="filter-tag-count">${n}</span>
      </button>
    `).join('')}
  `;
  el.querySelectorAll('.filter-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      filterTag = btn.dataset.tag;
      renderFilterTags();
      renderSaved();
    });
  });
}

function persistSaved() {
  saveSaved(saved);
}

function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function mergeRemote(incoming) {
  let changed = false;
  for (const remote of incoming) {
    if (!remote.id) continue;
    const i = saved.findIndex(p => p.id === remote.id);
    if (i === -1) {
      if (remote.deleted) continue;
      saved.unshift(remote);
      changed = true;
    } else {
      const local = saved[i];
      const localTs = local.updatedAt || local.savedAt || 0;
      const remoteTs = remote.updatedAt || remote.savedAt || 0;
      if (remoteTs > localTs) {
        if (remote.deleted) saved.splice(i, 1);
        else saved[i] = remote;
        changed = true;
      }
    }
  }
  if (changed) {
    saved.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    persistSaved();
    renderFilterTags();
    renderSaved();
  }
}

const sync = new Sync({
  onRemote: mergeRemote,
  onStatus: (s) => {
    const el = document.getElementById('sync-status');
    if (el) el.textContent = s;
  }
});
sync.start();

const isDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
if (isDev) {
  const purgeBtn = $('purge-btn');
  purgeBtn.hidden = false;
  purgeBtn.addEventListener('click', async () => {
    if (!confirm('Purge ALL local + server data? This cannot be undone.')) return;
    try {
      await fetch('http://127.0.0.1:8046/api/purge', { method: 'POST' });
    } catch {}
    localStorage.clear();
    location.reload();
  });
}

const audioCache = new Map();
let currentAudio = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const ICON_VOLUME = `<img src="./volume.svg" class="icon" alt="" aria-hidden="true">`;
const ICON_NETWORK = `<img src="./network.svg" class="icon" alt="" aria-hidden="true">`;
const ICON_QUESTION = `<img src="./circle-question-mark.svg" class="icon" alt="" aria-hidden="true">`;

async function speak(text, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  btn?.classList.add('loading');
  try {
    let url = audioCache.get(text);
    if (!url) {
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `TTS failed: ${res.status}`);
      }
      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      audioCache.set(text, url);
    }
    const audio = new Audio(url);
    currentAudio = audio;
    btn?.classList.remove('loading');
    btn?.classList.add('playing');
    audio.addEventListener('ended', () => {
      btn?.classList.remove('playing');
      if (currentAudio === audio) currentAudio = null;
    });
    audio.play();
  } catch (err) {
    btn?.classList.remove('loading', 'playing');
    status.textContent = `tts error · ${err.message}`;
  }
}

function bindSpeakButtons(root) {
  root.querySelectorAll('.speak-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      speak(btn.dataset.text, btn);
    });
  });
}

function actionsHTML(text, ctx) {
  const breakOpen = breakdownOpen.has(text);
  const qOpen = questionsOpen.has(text);
  const t = escapeHtml(text);
  const lit = escapeHtml(ctx?.literal || '');
  const intent = escapeHtml(ctx?.intent || '');
  return `
    <div class="actions">
      <button class="action-btn speak-btn" title="hear it" data-text="${t}">${ICON_VOLUME}</button>
      <button class="action-btn breakdown-toggle ${breakOpen ? 'active' : ''}" title="break it down" data-text="${t}">${ICON_NETWORK}</button>
      <button class="action-btn questions-toggle ${qOpen ? 'active' : ''}" title="ask a question" data-text="${t}" data-literal="${lit}" data-intent="${intent}">${ICON_QUESTION}</button>
    </div>
  `;
}

function speakOnlyHTML(text) {
  return `<div class="actions"><button class="action-btn speak-btn" title="hear it" data-text="${escapeHtml(text)}">${ICON_VOLUME}</button></div>`;
}

function breakdownHTML(text) {
  if (!breakdownOpen.has(text)) return '';
  const loading = breakdownLoading.has(text);
  const data = breakdownCache.get(text);
  if (loading) {
    return `<div class="breakdown-body"><span class="pulse"></span>thinking…</div>`;
  }
  if (!data) return '';
  return `
    <div class="breakdown-body">
      ${data.words.map(w => `
        <div class="word">
          <div class="word-surface" lang="es" translate="no">${escapeHtml(w.word)}</div>
          <div class="word-pos">${escapeHtml(w.pos)}</div>
          <div class="word-gloss">${escapeHtml(w.gloss)}</div>
          <div class="word-info">
            ${w.lemma && w.lemma.toLowerCase() !== w.word.toLowerCase()
              ? `<span class="word-lemma" lang="es" translate="no">${escapeHtml(w.lemma)}</span>` : ''}
            ${w.info.map(t => `<span class="word-tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

async function loadBreakdown(text, rerender) {
  if (breakdownCache.has(text) || breakdownLoading.has(text)) return;
  breakdownLoading.add(text);
  rerender();
  try {
    const res = await fetch(BREAKDOWN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `request failed: ${res.status}`);
    breakdownCache.set(text, data);
    persistBreakdowns();
  } catch (err) {
    breakdownOpen.delete(text);
    status.textContent = `breakdown error · ${err.message}`;
  } finally {
    breakdownLoading.delete(text);
    rerender();
  }
}

function questionsHTML(text, ctx) {
  if (!questionsOpen.has(text)) return '';
  const log = getQuestions(text);
  const loading = questionsLoading.has(text);
  return `
    <div class="questions-body">
      ${log.map(item => `
        <div class="qa">
          <div class="qa-q">${escapeHtml(item.q)}</div>
          <div class="qa-a">${escapeHtml(item.a)}</div>
        </div>
      `).join('')}
      <form class="qa-form" data-text="${escapeHtml(text)}"
            data-literal="${escapeHtml(ctx.literal || '')}"
            data-intent="${escapeHtml(ctx.intent || '')}">
        <input type="text" class="qa-input" placeholder="ask anything about this phrase…"
               ${loading ? 'disabled' : ''} autocomplete="off">
        <button type="submit" class="qa-send" ${loading ? 'disabled' : ''}>
          ${loading ? '…' : 'ask ›'}
        </button>
      </form>
    </div>
  `;
}

async function askQuestion(text, ctx, q, rerender) {
  if (questionsLoading.has(text)) return;
  questionsLoading.add(text);
  rerender();
  try {
    const history = getQuestions(text);
    const res = await fetch(QUESTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phrase: text,
        literal: ctx.literal || '',
        intent: ctx.intent || '',
        history,
        question: q
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `request failed: ${res.status}`);
    const log = history.slice();
    log.push({ q, a: data.answer, askedAt: Date.now() });
    questionsByText.set(text, log);
    persistQuestions();
  } catch (err) {
    status.textContent = `question error · ${err.message}`;
  } finally {
    questionsLoading.delete(text);
    rerender();
  }
}

function bindQuestionButtons(root, rerender) {
  root.querySelectorAll('.questions-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const text = btn.dataset.text;
      if (questionsOpen.has(text)) questionsOpen.delete(text);
      else questionsOpen.add(text);
      rerender();
    });
  });
  root.querySelectorAll('.qa-form').forEach(form => {
    form.addEventListener('click', e => e.stopPropagation());
    form.addEventListener('submit', e => {
      e.preventDefault();
      e.stopPropagation();
      const input = form.querySelector('.qa-input');
      const q = input.value.trim();
      if (!q) return;
      const text = form.dataset.text;
      const ctx = { literal: form.dataset.literal, intent: form.dataset.intent };
      input.value = '';
      askQuestion(text, ctx, q, rerender);
    });
  });
}

function bindBreakdownButtons(root, rerender) {
  root.querySelectorAll('.breakdown-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const text = btn.dataset.text;
      if (breakdownOpen.has(text)) {
        breakdownOpen.delete(text);
        rerender();
      } else {
        breakdownOpen.add(text);
        if (!breakdownCache.has(text)) loadBreakdown(text, rerender);
        else rerender();
      }
    });
  });
}

function bindActions(root, rerender) {
  bindSpeakButtons(root);
  bindBreakdownButtons(root, rerender);
  bindQuestionButtons(root, rerender);
}

// For both directions, every saved card has: { tag, direction, intent, es, en, literal }
//   en2es: intent = English ask, es = result, en = (same as intent — we don't store separately)
//   es2en: intent = Spanish input, es = intent, en = result

function groupSaved(list) {
  const byKey = new Map();
  const order = [];
  for (const p of list) {
    const key = p.direction === 'es2en'
      ? `es2en::${p.es}`
      : `en2es::${p.intent}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, direction: p.direction, intent: p.intent, tag: p.tag, es: p.es, phrases: [] };
      byKey.set(key, g);
      order.push(g);
    }
    g.phrases.push(p);
  }
  return order;
}

function savedGroupHTML(g) {
  if (g.direction === 'es2en') {
    const ctx = { literal: g.phrases[0].literal, intent: g.phrases[0].intent };
    const key = g.key;
    const sel = key === selectedSavedId ? ' selected' : '';
    return `
      <article class="card${sel}" data-id="${escapeHtml(key)}">
        <div class="card-meta">
          <span class="card-cat">${escapeHtml(g.tag)}</span>
          <span class="card-direction">ES → EN</span>
        </div>
        <div class="phrase-row">
          <div class="phrase-text">
            <div class="card-phrase" lang="es" translate="no">${escapeHtml(g.es)}</div>
          </div>
          ${actionsHTML(g.es, ctx)}
        </div>
        <div class="phrase-list">
          ${g.phrases.map(p => `
            <div class="group-row">
              <div class="card-meaning">${escapeHtml(p.en)}</div>
              <div class="card-literal">lit. ${escapeHtml(p.literal)}</div>
            </div>
          `).join('')}
        </div>
        ${breakdownHTML(g.es)}
        ${questionsHTML(g.es, ctx)}
      </article>
    `;
  }
  return `
    <article class="card">
      <div class="card-meta">
        <span class="card-cat">${escapeHtml(g.tag)}</span>
        <span class="card-direction">EN → ES</span>
      </div>
      <div class="card-intent">${escapeHtml(g.intent)}</div>
      <div class="phrase-list">
        ${g.phrases.map(p => {
          const ctx = { literal: p.literal, intent: p.intent };
          const rowKey = `en2es::${p.es}`;
          const rowSel = rowKey === selectedSavedId ? ' selected' : '';
          return `
            <div class="group-row${rowSel}" data-id="${escapeHtml(rowKey)}">
              <div class="phrase-row">
                <div class="phrase-text">
                  <div class="card-phrase" lang="es" translate="no">${escapeHtml(p.es)}</div>
                  <div class="card-literal">lit. ${escapeHtml(p.literal)}</div>
                </div>
                ${actionsHTML(p.es, ctx)}
              </div>
              ${breakdownHTML(p.es)}
              ${questionsHTML(p.es, ctx)}
            </div>
          `;
        }).join('')}
      </div>
    </article>
  `;
}

function renderSaved() {
  if (saved.length === 0) {
    listEl.innerHTML = pending
      ? ''
      : '<div class="list-empty">no phrases yet — ask one above.</div>';
    return;
  }
  const q = filterText.trim().toLowerCase();
  const visible = saved.filter(p => matchesFilter(p, q));
  if (visible.length === 0) {
    listEl.innerHTML = '<div class="list-empty">no matches.</div>';
    return;
  }
  listEl.innerHTML = groupSaved(visible).map(savedGroupHTML).join('');
  bindActions(listEl, renderSaved);
  listEl.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.action-btn, .qa-form, .qa-input, .qa-send, .breakdown-body')) return;
      if (window.getSelection().toString().trim()) return;
      e.stopPropagation();
      const id = el.dataset.id;
      const next = selectedSavedId === id ? null : id;
      if (next !== selectedSavedId) {
        breakdownOpen.clear();
        questionsOpen.clear();
      }
      selectedSavedId = next;
      renderSaved();
    });
  });
}

function pendingPhraseHTML(p, i) {
  const isEs2en = pending.direction === 'es2en';
  const main = isEs2en ? p.en : p.es;
  const ctx = { literal: p.literal, intent: pending.intent };
  return `
    <div class="phrase phrase-toggle ${p.selected ? 'on' : 'off'}" data-i="${i}">
      <div class="phrase-check">${p.selected ? '✓' : '+'}</div>
      <div class="phrase-content">
        <div class="phrase-row">
          <div class="phrase-text">
            <div class="card-phrase ${isEs2en ? 'is-en' : ''}" ${isEs2en ? '' : 'lang="es" translate="no"'}>${escapeHtml(main)}</div>
            <div class="card-literal">lit. ${escapeHtml(p.literal)}</div>
          </div>
          ${isEs2en ? '' : actionsHTML(p.es, ctx)}
        </div>
        ${isEs2en ? '' : breakdownHTML(p.es) + questionsHTML(p.es, ctx)}
      </div>
    </div>
  `;
}

function renderPending() {
  if (!pending) {
    pendingEl.innerHTML = '';
    return;
  }
  const isEs2en = pending.direction === 'es2en';
  const selectedCount = pending.phrases.filter(p => p.selected).length;
  pendingEl.innerHTML = `
    <div class="pending-card">
      <div class="card-meta">
        <span class="card-cat">${escapeHtml(pending.tag)}</span>
        <span class="card-direction">${isEs2en ? 'ES → EN' : 'EN → ES'}</span>
        <span class="pending-label">choose what to keep</span>
      </div>
      ${isEs2en
        ? `${actionsHTML(pending.intent, { literal: '', intent: '' })}
           <div class="card-phrase pending-source" lang="es" translate="no">${escapeHtml(pending.intent)}</div>
           ${breakdownHTML(pending.intent)}
           ${questionsHTML(pending.intent, { literal: '', intent: '' })}`
        : `<div class="card-intent">${escapeHtml(pending.intent)}</div>`
      }
      <div class="phrase-list">
        ${pending.phrases.map(pendingPhraseHTML).join('')}
      </div>
      <div class="pending-actions">
        <button class="action-link muted" id="pending-discard">Discard all</button>
        <button class="action-link" id="pending-save">
          Save ${selectedCount} ${selectedCount === 1 ? 'phrase' : 'phrases'}
        </button>
      </div>
    </div>
  `;

  bindActions(pendingEl, renderPending);
  pendingEl.querySelectorAll('.phrase-toggle').forEach(el => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      pending.phrases[i].selected = !pending.phrases[i].selected;
      renderPending();
    });
  });
  $('pending-discard').addEventListener('click', () => {
    pending = null;
    renderPending();
    renderSaved();
  });
  $('pending-save').addEventListener('click', () => {
    const kept = pending.phrases.filter(p => p.selected);
    const now = Date.now();
    for (const p of kept) {
      const record = pending.direction === 'es2en'
        ? {
            id: newId(),
            direction: 'es2en',
            tag: pending.tag,
            intent: pending.intent,
            es: pending.intent,
            en: p.en,
            literal: p.literal,
            savedAt: now,
            updatedAt: now
          }
        : {
            id: newId(),
            direction: 'en2es',
            tag: pending.tag,
            intent: pending.intent,
            es: p.es,
            literal: p.literal,
            savedAt: now,
            updatedAt: now
          };
      saved.unshift(record);
      sync.push(record);
    }
    persistSaved();
    pending = null;
    renderPending();
    renderFilterTags();
    renderSaved();
  });
}

async function ask() {
  const intent = input.value.trim();
  if (!intent) { input.focus(); return; }
  status.innerHTML = '<span class="pulse"></span>thinking…';
  try {
    const res = await fetch(ASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, direction: mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `request failed: ${res.status}`);
    pending = {
      intent,
      direction: data.direction || mode,
      tag: data.tag,
      phrases: data.phrases.map(p => ({ ...p, selected: false }))
    };
    input.value = '';
    status.textContent = '';
    renderPending();
    renderSaved();
  } catch (err) {
    status.textContent = `error · ${err.message}`;
  }
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  input.placeholder = PLACEHOLDERS[mode];
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

const filterInput = $('filter-input');
filterInput.addEventListener('input', () => {
  filterText = filterInput.value;
  renderSaved();
});

input.addEventListener('input', () => {
  status.textContent = '';
});

input.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); ask(); }
});

renderPending();
renderFilterTags();
renderSaved();
