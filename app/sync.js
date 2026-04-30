import { loadSyncState, saveSyncState, loadDeviceId } from './storage.js';

const SYNC_HOST = globalThis.DICHOS_CONFIG?.syncBaseUrl || 'http://127.0.0.1:8046';
const WS_HOST = SYNC_HOST.replace(/^http/, 'ws');

export class Sync {
  constructor({ onRemote, onStatus }) {
    this.onRemote = onRemote;       // (phrases) => void — apply incoming
    this.onStatus = onStatus || (() => {});
    this.deviceId = loadDeviceId();
    this.state = loadSyncState();   // { highWatermark }
    this.pending = [];              // phrases queued to send
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
    if (typeof data?.highWatermark === 'number' && data.highWatermark > this.state.highWatermark) {
      this.state.highWatermark = data.highWatermark;
      saveSyncState(this.state);
    }
  }

  handleAck(msg) {
    const ids = new Set(msg.confirmedIds || []);
    this.pending = this.pending.filter(p => !ids.has(p.id));
    if (typeof msg.highWatermark === 'number' && msg.highWatermark > this.state.highWatermark) {
      this.state.highWatermark = msg.highWatermark;
      saveSyncState(this.state);
    }
  }

  push(phrase) {
    this.pending.push(phrase);
    this.flush();
  }

  flush() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.flushHttp();
      return;
    }
    if (!this.pending.length) return;
    this.socket.send(JSON.stringify({ type: 'push', phrases: this.pending.slice() }));
  }

  async flushHttp() {
    if (!this.pending.length) return;
    const sending = this.pending.slice();
    try {
      const res = await fetch(`${SYNC_HOST}/api/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrases: sending, since: this.state.highWatermark })
      });
      if (!res.ok) throw new Error(`push ${res.status}`);
      const data = await res.json();
      const ids = new Set(data.confirmedIds || []);
      this.pending = this.pending.filter(p => !ids.has(p.id));
      this.applySnapshot(data);
    } catch {
      // leave pending; will retry on reconnect
    }
  }
}
