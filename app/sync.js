import { loadSyncState, saveSyncState, loadDeviceId } from './storage.js';

const SYNC_HOST = globalThis.DICHOS_CONFIG?.syncBaseUrl || 'http://127.0.0.1:8046';
const WS_HOST = SYNC_HOST.replace(/^http/, 'ws');

export class Sync {
  constructor({ onRemote, onRemoteBreakdowns, onRemoteQuestions, onRemoteConjugations, onStatus }) {
    this.onRemote = onRemote;       // (phrases) => void — apply incoming
    this.onRemoteBreakdowns = onRemoteBreakdowns || (() => {});
    this.onRemoteQuestions = onRemoteQuestions || (() => {});
    this.onRemoteConjugations = onRemoteConjugations || (() => {});
    this.onStatus = onStatus || (() => {});
    this.deviceId = loadDeviceId();
    this.state = loadSyncState();   // { highWatermark }
    this.pending = [];              // phrases queued to send
    this.pendingBreakdowns = [];    // breakdowns queued to send
    this.pendingQuestions = [];     // questions queued to send
    this.pendingConjugations = []; // conjugations queued to send
    this.socket = null;
    this.reconnectDelay = 1000;
    this.connecting = false;
    this.closed = false;
  }

  start() {
    this.bootstrap();
    this.connect();
  }

  // Initial HTTP catch-up before WS opens — works even if WS is blocked.
  async bootstrap() {
    try {
      const res = await fetch(`${SYNC_HOST}/api/sync?since=${this.state.highWatermark}`);
      if (!res.ok) throw new Error(`bootstrap ${res.status}`);
      const data = await res.json();
      this.applySnapshot(data);
    } catch (err) {
      this.onStatus(`offline · ${err.message}`);
    }
  }

  connect() {
    if (this.closed || this.connecting) return;
    this.connecting = true;
    this.onStatus('connecting…');
    let socket;
    try {
      socket = new WebSocket(`${WS_HOST}/api/sync/ws`);
    } catch (err) {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.connecting = false;
      this.reconnectDelay = 1000;
      this.onStatus('synced');
      socket.send(JSON.stringify({ type: 'hello', since: this.state.highWatermark }));
      this.flush();
    });

    socket.addEventListener('message', e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'snapshot' || msg.type === 'phrases') {
        this.applySnapshot(msg);
      } else if (msg.type === 'breakdowns' || msg.type === 'questions' || msg.type === 'conjugations') {
        this.applySnapshot(msg);
      } else if (msg.type === 'ack') {
        this.handleAck(msg);
      } else if (msg.type === 'purge') {
        try { localStorage.clear(); } catch {}
        location.reload();
      } else if (msg.type === 'error') {
        this.onStatus(`sync error · ${msg.message}`);
      }
    });

    socket.addEventListener('close', () => {
      this.connecting = false;
      this.socket = null;
      if (!this.closed) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      try { socket.close(); } catch {}
    });
  }

  scheduleReconnect() {
    this.onStatus('offline');
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
  }

  applySnapshot(data) {
    const phrases = Array.isArray(data?.phrases) ? data.phrases : [];
    if (phrases.length) this.onRemote(phrases);
    const breakdowns = Array.isArray(data?.breakdowns) ? data.breakdowns : [];
    if (breakdowns.length) this.onRemoteBreakdowns(breakdowns);
    const questions = Array.isArray(data?.questions) ? data.questions : [];
    if (questions.length) this.onRemoteQuestions(questions);
    const conjugations = Array.isArray(data?.conjugations) ? data.conjugations : [];
    if (conjugations.length) this.onRemoteConjugations(conjugations);
    if (typeof data?.highWatermark === 'number' && data.highWatermark > this.state.highWatermark) {
      this.state.highWatermark = data.highWatermark;
      saveSyncState(this.state);
    }
  }

  handleAck(msg) {
    const ids = new Set(msg.confirmedIds || []);
    this.pending = this.pending.filter(p => !ids.has(p.id));
    const texts = new Set(msg.confirmedTexts || []);
    this.pendingBreakdowns = this.pendingBreakdowns.filter(b => !texts.has(b.text));
    const qids = new Set(msg.confirmedQuestionIds || []);
    this.pendingQuestions = this.pendingQuestions.filter(q => !qids.has(q.id));
    const lemmas = new Set(msg.confirmedLemmas || []);
    this.pendingConjugations = this.pendingConjugations.filter(c => !lemmas.has(c.lemma));
    if (typeof msg.highWatermark === 'number' && msg.highWatermark > this.state.highWatermark) {
      this.state.highWatermark = msg.highWatermark;
      saveSyncState(this.state);
    }
  }

  push(phrase) {
    this.pending.push(phrase);
    this.flush();
  }

  pushBreakdown(breakdown) {
    this.pendingBreakdowns = this.pendingBreakdowns.filter(b => b.text !== breakdown.text);
    this.pendingBreakdowns.push(breakdown);
    this.flush();
  }

  pushQuestion(question) {
    this.pendingQuestions = this.pendingQuestions.filter(q => q.id !== question.id);
    this.pendingQuestions.push(question);
    this.flush();
  }

  pushConjugation(conjugation) {
    this.pendingConjugations = this.pendingConjugations.filter(c => c.lemma !== conjugation.lemma);
    this.pendingConjugations.push(conjugation);
    this.flush();
  }

  flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.flushHttp();
      return;
    }
    if (!this.pending.length && !this.pendingBreakdowns.length && !this.pendingQuestions.length && !this.pendingConjugations.length) return;
    this.socket.send(JSON.stringify({
      type: 'push',
      phrases: this.pending.slice(),
      breakdowns: this.pendingBreakdowns.slice(),
      questions: this.pendingQuestions.slice(),
      conjugations: this.pendingConjugations.slice()
    }));
  }

  async flushHttp() {
    if (!this.pending.length && !this.pendingBreakdowns.length && !this.pendingQuestions.length && !this.pendingConjugations.length) return;
    const sendingPhrases = this.pending.slice();
    const sendingBreakdowns = this.pendingBreakdowns.slice();
    const sendingQuestions = this.pendingQuestions.slice();
    const sendingConjugations = this.pendingConjugations.slice();
    try {
      const res = await fetch(`${SYNC_HOST}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phrases: sendingPhrases,
          breakdowns: sendingBreakdowns,
          questions: sendingQuestions,
          conjugations: sendingConjugations,
          since: this.state.highWatermark
        })
      });
      if (!res.ok) throw new Error(`push ${res.status}`);
      const data = await res.json();
      const ids = new Set(data.confirmedIds || []);
      this.pending = this.pending.filter(p => !ids.has(p.id));
      const texts = new Set(data.confirmedTexts || []);
      this.pendingBreakdowns = this.pendingBreakdowns.filter(b => !texts.has(b.text));
      const qids = new Set(data.confirmedQuestionIds || []);
      this.pendingQuestions = this.pendingQuestions.filter(q => !qids.has(q.id));
      const lemmas = new Set(data.confirmedLemmas || []);
      this.pendingConjugations = this.pendingConjugations.filter(c => !lemmas.has(c.lemma));
      this.applySnapshot(data);
    } catch {
      // leave pending; will retry on reconnect
    }
  }
}
