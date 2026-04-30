const HOST = globalThis.location?.hostname || "";
const IS_LOCAL = HOST === "localhost" ||
  HOST === "127.0.0.1" ||
  HOST.endsWith(".local") ||
  /^10\./.test(HOST) ||
  /^192\.168\./.test(HOST) ||
  /^169\.254\./.test(HOST) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(HOST);

globalThis.DICHOS_CONFIG = globalThis.DICHOS_CONFIG || {
  isLocal: IS_LOCAL,
  askBaseUrl: IS_LOCAL ? "http://127.0.0.1:8045" : "https://dichos-ask.emh.workers.dev",
  syncBaseUrl: IS_LOCAL ? "http://127.0.0.1:8046" : "https://dichos-sync.emh.workers.dev"
};
