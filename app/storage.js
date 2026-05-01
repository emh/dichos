const SAVED_KEY = 'dichos.saved.v1';
const BREAKDOWN_KEY = 'dichos.breakdowns.v1';
const QUESTIONS_KEY = 'dichos.questions.v1';
const CONJUGATIONS_KEY = 'dichos.conjugations.v1';
const SRS_KEY = 'dichos.srs.v1';
const SYNC_KEY = 'dichos.sync.v1';
const DEVICE_KEY = 'dichos.device.v1';

export function loadSrs() {
  try {
    const raw = localStorage.getItem(SRS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveSrs(map) {
  try { localStorage.setItem(SRS_KEY, JSON.stringify(map)); } catch {}
}

export function loadQuestions() {
  try {
    const raw = localStorage.getItem(QUESTIONS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveQuestions(map) {
  try { localStorage.setItem(QUESTIONS_KEY, JSON.stringify(map)); } catch {}
}

export function loadSyncState() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return { highWatermark: 0 };
    const data = JSON.parse(raw);
    return { highWatermark: Number(data?.highWatermark) || 0 };
  } catch {
    return { highWatermark: 0 };
  }
}

export function saveSyncState(state) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(state)); } catch {}
}

export function loadDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(DEVICE_KEY, id); } catch {}
  }
  return id;
}

export function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveSaved(list) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('failed to persist saved phrases', err);
  }
}

export function loadBreakdowns() {
  try {
    const raw = localStorage.getItem(BREAKDOWN_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveBreakdowns(map) {
  try {
    localStorage.setItem(BREAKDOWN_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('failed to persist breakdowns', err);
  }
}

export function loadConjugations() {
  try {
    const raw = localStorage.getItem(CONJUGATIONS_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export function saveConjugations(map) {
  try {
    localStorage.setItem(CONJUGATIONS_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn('failed to persist conjugations', err);
  }
}
