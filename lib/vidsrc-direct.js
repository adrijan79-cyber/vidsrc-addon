const API_BASE = "https://data.vidsrcme.ru/api.php";
const REFERER = "https://cloudorchestranova.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64(input) {
  const normalized = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

async function decryptStreamUrls(encryptedB64, wasmUrl) {
  const wasmRes = await fetchWithTimeout(
    wasmUrl,
    {
      headers: {
        Accept: "*/*",
        "User-Agent": UA,
        Referer: REFERER,
      },
    },
    10000
  );
  if (!wasmRes.ok) {
    throw new Error(`wasm http ${wasmRes.status}`);
  }

  const wasmBytes = new Uint8Array(await wasmRes.arrayBuffer());
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {});
  const { memory, alloc, decrypt } = instance.exports || {};

  if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== "function" || typeof decrypt !== "function") {
    throw new Error("unexpected wasm exports");
  }

  const encrypted = decodeBase64(encryptedB64);
  const ptr = alloc(encrypted.length);
  new Uint8Array(memory.buffer, ptr, encrypted.length).set(encrypted);

  const outLen = decrypt(ptr, encrypted.length);
  if (!Number.isFinite(outLen) || outLen <= 0) return [];

  const plain = new TextDecoder().decode(
    new Uint8Array(memory.buffer, ptr + 12, outLen)
  );

  return plain
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => /^https?:\/\//i.test(x));
}

export async function resolveVidSrc({ type, imdbId, season, episode }) {
  const mediaType = type === "series" ? "tv" : "movie";
  const params = new URLSearchParams({
    type: mediaType,
    imdb: imdbId,
  });

  if (mediaType === "tv") {
    params.set("season", String(season));
    params.set("episode", String(episode));
  }

  // Asking for stream_urls makes the current VidSrc backend include the
  // encrypted HLS list and the per-window WASM decryptor URL.
  params.set("stream_urls", "");

  const apiRes = await fetchWithTimeout(
    `${API_BASE}?${params.toString()}`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
        Referer: REFERER,
      },
    },
    10000
  );

  if (!apiRes.ok) {
    throw new Error(`vidsrc api http ${apiRes.status}`);
  }

  const payload = await apiRes.json();
  const raw = payload?.data?.stream_urls;

  let urls = [];
  if (Array.isArray(raw)) {
    urls = raw.filter((x) => typeof x === "string" && /^https?:\/\//i.test(x));
  } else if (typeof raw === "string" && raw.length > 0) {
    if (!payload?.vs?.wasm_url) {
      throw new Error("missing wasm_url");
    }
    urls = await decryptStreamUrls(raw, payload.vs.wasm_url);
  }

  return {
    title: payload?.data?.title || payload?.data?.file_name || "VidSrc",
    urls: [...new Set(urls)],
    referer: REFERER,
  };
}

export { REFERER, UA };
