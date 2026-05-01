// SM-2 with 4 grades (Again/Hard/Good/Easy). Per-card state kept in
// localStorage by main.js — this module is pure logic + card derivation.

const DAY = 86400_000;
const MIN = 60_000;
const EASE_FLOOR = 1.3;

export const GRADES = { AGAIN: 2, HARD: 3, GOOD: 4, EASY: 5 };

export function defaultState(now = Date.now()) {
  return {
    ease: 2.5,
    interval: 0,        // days
    reps: 0,
    lapses: 0,
    due: now,
    lastReviewed: null
  };
}

// Derives the two cards (en2es, es2en) for a phrase.
//   en2es phrase: { intent: <EN>, es: <ES>, en?: '', literal }
//   es2en phrase: { intent: <ES>, es: <ES>, en: <EN>, literal }
export function cardsForPhrase(p) {
  if (!p || !p.id) return [];
  const literal = p.literal || '';
  if (p.direction === 'es2en') {
    return [
      { id: `${p.id}::en2es`, phraseId: p.id, dir: 'en2es', prompt: p.en || '', answer: p.es || '', literal },
      { id: `${p.id}::es2en`, phraseId: p.id, dir: 'es2en', prompt: p.es || '', answer: p.en || '', literal }
    ];
  }
  // en2es (default)
  return [
    { id: `${p.id}::en2es`, phraseId: p.id, dir: 'en2es', prompt: p.intent || '', answer: p.es || '', literal },
    { id: `${p.id}::es2en`, phraseId: p.id, dir: 'es2en', prompt: p.es || '', answer: p.intent || '', literal }
  ];
}

export function allCardsFor(saved) {
  return saved.flatMap(cardsForPhrase).filter(c => c.prompt && c.answer);
}

// Walk saved phrases and ensure every card id has a state entry. Drop orphans.
// Returns the (possibly mutated) map and a `changed` flag.
export function reconcile(saved, srsMap, now = Date.now()) {
  const valid = new Set();
  let changed = false;
  for (const p of saved) {
    for (const c of cardsForPhrase(p)) {
      if (!c.prompt || !c.answer) continue;
      valid.add(c.id);
      if (!srsMap[c.id]) {
        srsMap[c.id] = defaultState(p.savedAt || now);
        changed = true;
      }
    }
  }
  for (const id of Object.keys(srsMap)) {
    if (!valid.has(id)) {
      delete srsMap[id];
      changed = true;
    }
  }
  return { map: srsMap, changed };
}

// Cards whose state.due <= now. Returns card objects merged with state.
export function dueCards(saved, srsMap, now = Date.now()) {
  const out = [];
  for (const c of allCardsFor(saved)) {
    const s = srsMap[c.id];
    if (!s) continue;
    if (s.due <= now) out.push({ ...c, state: s });
  }
  out.sort((a, b) => a.state.due - b.state.due);
  return out;
}

export function dueCount(saved, srsMap, now = Date.now()) {
  return dueCards(saved, srsMap, now).length;
}

// Apply a grade to a card's state and return the new state.
// q in {AGAIN=2, HARD=3, GOOD=4, EASY=5}.
export function schedule(state, q, now = Date.now()) {
  const prev = state || defaultState(now);
  if (q === GRADES.AGAIN) {
    return {
      ease: Math.max(EASE_FLOOR, prev.ease - 0.20),
      interval: 0,                     // <1 day; held in queue via due timestamp
      reps: 0,
      lapses: prev.lapses + 1,
      due: now + MIN,                  // ~1 min later, same session
      lastReviewed: now
    };
  }

  // base interval if treated as Good
  let interval;
  if (prev.reps === 0) interval = 1;
  else if (prev.reps === 1) interval = 6;
  else interval = Math.max(1, Math.round(prev.interval * prev.ease));

  let ease = prev.ease;
  if (q === GRADES.HARD) {
    interval = Math.max(1, Math.round(prev.interval * 1.2 || 1));
    ease = Math.max(EASE_FLOOR, prev.ease - 0.15);
  } else if (q === GRADES.EASY) {
    interval = Math.max(1, Math.round(interval * 1.3));
    ease = prev.ease + 0.15;
  }

  return {
    ease,
    interval,
    reps: prev.reps + 1,
    lapses: prev.lapses,
    due: now + interval * DAY,
    lastReviewed: now
  };
}

// Returns predicted next interval label for each grade, given current state.
export function predictedIntervals(state, now = Date.now()) {
  return {
    again: '<1m',
    hard: humanInterval(schedule(state, GRADES.HARD, now).due - now),
    good: humanInterval(schedule(state, GRADES.GOOD, now).due - now),
    easy: humanInterval(schedule(state, GRADES.EASY, now).due - now)
  };
}

function humanInterval(ms) {
  if (ms < MIN) return '<1m';
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}m`;
  if (ms < 24 * 60 * MIN) return `${Math.round(ms / (60 * MIN))}h`;
  const days = Math.round(ms / DAY);
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}
