const EN2ES_PROMPT = `You translate the user's English input into idiomatic Spanish. Translate exactly what they wrote — do not expand it.

- Noun phrase in → noun phrase out. ("sunny side up eggs" → "huevos estrellados", not "I'd like to order…")
- Question in → question out.
- Full sentence in → full sentence out.

Return 2–4 phrases. Include common alternates a native might also say: a regional variant, a more colloquial form, a more formal form, a synonym, etc. Only return 1 if the phrase is genuinely fixed with no real alternative.

For each phrase include a literal English back-translation: how the Spanish actually reads word-for-word, not the meaning.

Default to neutral Latin American Spanish. Note a regional form only when it materially differs.

Return JSON only:
{
  "tag": "food|social|directions|work|slang|emergencies|travel|shopping|feelings|other",
  "phrases": [
    { "es": "...", "literal": "..." }
  ]
}`;

const QUESTION_PROMPT = `You're helping a learner understand a specific Spanish phrase. They have the phrase, its literal back-translation, and ask follow-up questions about it.

Answer briefly and conversationally — 1–3 sentences. Address their actual question:
- About a word → explain it in this phrase's context.
- About grammar → point at what's happening here.
- About usage → say where, when, and to whom it fits.
- About culture or register → be concrete.

Plain prose. No markdown. No headers. No lists unless the question genuinely calls for one.`;

const BREAKDOWN_PROMPT = `You break a Spanish phrase down word by word for a learner. For each token in the phrase (skip pure punctuation), return:

- "word": the surface form as it appears in the phrase.
- "lemma": the dictionary form (infinitive for verbs, masculine singular for adjectives, singular for nouns).
- "pos": one of: noun, verb, adjective, adverb, article, pronoun, preposition, conjunction, interjection, determiner, contraction, other.
- "gloss": short English meaning of THIS word in THIS context (1–4 words).
- "info": array of short lowercase tags relevant to this word:
   - nouns: gender ("masculine"/"feminine"), number ("singular"/"plural"), diminutive if applicable
   - verbs: tense (present/preterite/imperfect/future/conditional/perfect), mood (indicative/subjunctive/imperative), person+number ("1st singular", etc.), reflexive if applicable
   - adjectives: gender, number, comparative/superlative if applicable
   - articles/determiners: definite/indefinite, gender, number
   - pronouns: type (subject/direct-object/indirect-object/reflexive/possessive/etc.), person+number
   - register tags ("formal"/"informal") when meaningful
   - mark contractions ("al" = "a + el")

Keep tags short. No commentary outside the JSON.

Return JSON only:
{
  "words": [
    { "word": "...", "lemma": "...", "pos": "...", "gloss": "...", "info": ["..."] }
  ]
}`;

const ES2EN_PROMPT = `You translate the user's Spanish input into natural English. Translate exactly what they wrote — do not expand it.

Return 1–3 English translations. Add more than one only when there's a real difference in meaning, register, or common alternate phrasing. Most Spanish phrases have one good English equivalent.

For each translation:
- "en": natural, idiomatic English a fluent speaker would actually say.
- "literal": a literal word-for-word reading of the Spanish, even when it sounds odd in English. This shows how the Spanish actually works.

Return JSON only:
{
  "tag": "food|social|directions|work|slang|emergencies|travel|shopping|feelings|other",
  "phrases": [
    { "en": "...", "literal": "..." }
  ]
}`;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST") {
        return json({ error: "Not found" }, 404, cors);
      }

      if (!isAuthorized(request, env)) {
        return json({ error: "Unauthorized" }, 401, cors);
      }

      if (!env.OPENAI_API_KEY) {
        return json({ error: "OPENAI_API_KEY is not configured" }, 500, cors);
      }

      if (url.pathname === "/api/ask") {
        const body = await request.json();
        const intent = (body?.intent || "").trim();
        const direction = body?.direction === "es2en" ? "es2en" : "en2es";
        if (!intent) return json({ error: "intent is required" }, 400, cors);
        const result = await askOpenAI(intent, direction, env);
        return json(result, 200, cors);
      }

      if (url.pathname === "/api/question") {
        const body = await request.json();
        const phrase = (body?.phrase || "").trim();
        const question = (body?.question || "").trim();
        if (!phrase || !question) {
          return json({ error: "phrase and question are required" }, 400, cors);
        }
        const result = await answerQuestion({
          phrase,
          literal: String(body?.literal || "").trim(),
          intent: String(body?.intent || "").trim(),
          history: Array.isArray(body?.history) ? body.history : [],
          question
        }, env);
        return json(result, 200, cors);
      }

      if (url.pathname === "/api/breakdown") {
        const body = await request.json();
        const text = (body?.text || "").trim();
        if (!text) return json({ error: "text is required" }, 400, cors);
        const result = await breakdown(text, env);
        return json(result, 200, cors);
      }

      if (url.pathname === "/api/tts") {
        const body = await request.json();
        const text = (body?.text || "").trim();
        if (!text) return json({ error: "text is required" }, 400, cors);
        return await speak(text, env, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, 500, cors);
    }
  }
};

async function askOpenAI(intent, direction, env) {
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const systemPrompt = direction === "es2en" ? ES2EN_PROMPT : EN2ES_PROMPT;
  const userLabel = direction === "es2en" ? "Spanish" : "Intent";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${userLabel}: ${intent}` }
      ]
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `OpenAI request failed: ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenAI returned no answer");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned malformed JSON");
  }

  const tag = String(parsed.tag || "other").trim().toLowerCase();
  const rawPhrases = Array.isArray(parsed.phrases) ? parsed.phrases : [];
  const key = direction === "es2en" ? "en" : "es";
  const phrases = rawPhrases
    .map((p) => ({
      [key]: String(p?.[key] || "").trim(),
      literal: String(p?.literal || "").trim()
    }))
    .filter((p) => p[key] && p.literal);

  if (phrases.length === 0) throw new Error("OpenAI response had no phrases");

  return { tag, direction, phrases };
}

async function answerQuestion({ phrase, literal, intent, history, question }, env) {
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";

  const contextLines = [`Phrase: ${phrase}`];
  if (literal) contextLines.push(`Literal: ${literal}`);
  if (intent) contextLines.push(`Original intent: ${intent}`);
  const context = contextLines.join("\n");

  const messages = [{ role: "system", content: QUESTION_PROMPT }];
  let firstUserContent = `${context}\nQuestion: ${question}`;
  const validHistory = history.filter(h => h && h.q && h.a);

  if (validHistory.length) {
    messages.push({ role: "user", content: `${context}\nQuestion: ${validHistory[0].q}` });
    messages.push({ role: "assistant", content: validHistory[0].a });
    for (let i = 1; i < validHistory.length; i++) {
      messages.push({ role: "user", content: `Question: ${validHistory[i].q}` });
      messages.push({ role: "assistant", content: validHistory[i].a });
    }
    messages.push({ role: "user", content: `Question: ${question}` });
  } else {
    messages.push({ role: "user", content: firstUserContent });
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model, messages })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `OpenAI request failed: ${response.status}`);
  }

  const payload = await response.json();
  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("OpenAI returned no answer");
  return { answer };
}

async function breakdown(text, env) {
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: BREAKDOWN_PROMPT },
        { role: "user", content: `Phrase: ${text}` }
      ]
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `OpenAI request failed: ${response.status}`);
  }

  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("OpenAI returned no answer");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned malformed JSON");
  }

  const rawWords = Array.isArray(parsed.words) ? parsed.words : [];
  const words = rawWords
    .map((w) => ({
      word: String(w?.word || "").trim(),
      lemma: String(w?.lemma || "").trim(),
      pos: String(w?.pos || "other").trim().toLowerCase(),
      gloss: String(w?.gloss || "").trim(),
      info: Array.isArray(w?.info)
        ? w.info.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
        : []
    }))
    .filter((w) => w.word);

  if (words.length === 0) throw new Error("OpenAI response had no words");

  return { words };
}

async function speak(text, env, cors) {
  const model = env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = env.OPENAI_TTS_VOICE || "nova";

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: "mp3",
      instructions: "Speak in natural, conversational Latin American Spanish."
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    return json({ error: payload?.error?.message || `TTS failed: ${response.status}` }, 500, cors);
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=86400"
    }
  });
}

function isAuthorized(request, env) {
  if (!env.APP_TOKEN) return true;
  const authorization = request.headers.get("Authorization") || "";
  const explicit = request.headers.get("X-Dichos-Token") || "";
  return authorization === `Bearer ${env.APP_TOKEN}` || explicit === env.APP_TOKEN;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dichos-Token",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
  });
}

function messageFromError(error) {
  return error instanceof Error ? error.message : "Request failed";
}
