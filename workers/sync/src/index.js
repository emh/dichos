const ROOM_NAME = "global";

const PHRASE_FIELDS = [
  "id", "direction", "tag", "intent", "es", "en", "literal", "savedAt", "deleted", "updatedAt"
];

export class Phrasebook {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.initialize();
  }

  async initialize() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS phrases (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS phrases_updated_at_idx ON phrases(updated_at)"
    );
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/sync/ws" && request.method === "GET") {
        return this.handleWebSocket(request);
      }
      if (url.pathname === "/api/sync" && request.method === "GET") {
        const since = numberOrZero(url.searchParams.get("since"));
        return json(this.snapshot(since), 200, cors);
      }
      if (url.pathname === "/api/purge" && request.method === "POST") {
        if (!isLocalDev(request, this.env)) {
          return json({ error: "Purge is dev-only" }, 403, cors);
        }
        this.state.storage.sql.exec("DELETE FROM phrases");
        this.broadcast(null, { type: "purge" });
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const body = await readJson(request);
        const since = numberOrZero(body?.since);
        const accepted = this.applyPhrases(Array.isArray(body?.phrases) ? body.phrases : []);
        if (accepted.length) {
          this.broadcast(null, { type: "phrases", phrases: accepted, highWatermark: this.highWatermark() });
        }
        return json({
          phrases: this.phrasesSince(since),
          confirmedIds: accepted.map(p => p.id),
          highWatermark: this.highWatermark()
        }, 200, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, 400, cors);
    }
  }

  handleWebSocket(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    await this.ready;
    try {
      const message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (message.type === "hello") {
        const since = numberOrZero(message.since);
        socket.send(JSON.stringify({
          type: "snapshot",
          phrases: this.phrasesSince(since),
          highWatermark: this.highWatermark()
        }));
        return;
      }
      if (message.type === "push") {
        const accepted = this.applyPhrases(Array.isArray(message.phrases) ? message.phrases : []);
        socket.send(JSON.stringify({
          type: "ack",
          confirmedIds: accepted.map(p => p.id),
          highWatermark: this.highWatermark()
        }));
        if (accepted.length) {
          this.broadcast(socket, {
            type: "phrases",
            phrases: accepted,
            highWatermark: this.highWatermark()
          });
        }
        return;
      }
      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}
  webSocketError() {}

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) continue;
      try { socket.send(raw); } catch {}
    }
  }

  applyPhrases(input) {
    const accepted = [];
    for (const candidate of input) {
      const phrase = normalizePhrase(candidate);
      if (!phrase) continue;
      const existing = [...this.state.storage.sql.exec(
        "SELECT updated_at FROM phrases WHERE id = ?", phrase.id
      )][0];
      if (existing && existing.updated_at >= phrase.updatedAt) continue;
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO phrases (id, json, updated_at) VALUES (?, ?, ?)",
        phrase.id, JSON.stringify(phrase), phrase.updatedAt
      );
      accepted.push(phrase);
    }
    return accepted;
  }

  phrasesSince(since) {
    const rows = since
      ? [...this.state.storage.sql.exec(
          "SELECT json FROM phrases WHERE updated_at > ? ORDER BY updated_at ASC", since
        )]
      : [...this.state.storage.sql.exec(
          "SELECT json FROM phrases ORDER BY updated_at ASC"
        )];
    return rows.map(row => JSON.parse(row.json));
  }

  highWatermark() {
    const rows = [...this.state.storage.sql.exec(
      "SELECT updated_at FROM phrases ORDER BY updated_at DESC LIMIT 1"
    )];
    return rows[0]?.updated_at || 0;
  }

  snapshot(since) {
    return {
      phrases: this.phrasesSince(since),
      highWatermark: this.highWatermark()
    };
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const id = env.PHRASEBOOK.idFromName(ROOM_NAME);
    const room = env.PHRASEBOOK.get(id);
    return room.fetch(request);
  }
};

function normalizePhrase(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  if (!id) return null;
  const direction = input.direction === "es2en" ? "es2en" : "en2es";
  const phrase = {
    id,
    direction,
    tag: String(input.tag || "other").trim().toLowerCase().slice(0, 32),
    intent: String(input.intent || "").trim().slice(0, 1000),
    es: String(input.es || "").trim().slice(0, 1000),
    en: String(input.en || "").trim().slice(0, 1000),
    literal: String(input.literal || "").trim().slice(0, 1000),
    savedAt: numberOrZero(input.savedAt) || Date.now(),
    deleted: Boolean(input.deleted),
    updatedAt: numberOrZero(input.updatedAt) || Date.now()
  };
  if (!phrase.es) return null;
  return phrase;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin && isAllowedOrigin(request, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function isLocalDev(request, env) {
  const origin = request.headers.get("Origin") || "";
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes("*") || allowed.includes(origin);
}

function json(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}
