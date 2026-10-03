import { Readable } from "node:stream";
import http from "node:http";
import https from "node:https";
import { signTarget, verifyTarget } from "../lib/proxy-sign.js";
import { REFERER, UA } from "../lib/vidsrc-direct.js";

// Keep issuance and use of an IP-bound token on an isolated connection.
export function createUpstreamSession() {
  const agents = {
    "http:": new http.Agent({ keepAlive: true, maxSockets: 1 }),
    "https:": new https.Agent({ keepAlive: true, maxSockets: 1 }),
  };
  async function fetchSession(rawUrl, options = {}, redirects = 0) {
    const url = new URL(rawUrl);
    if (!agents[url.protocol]) throw new Error("unsupported_protocol");
    const response = await new Promise((resolve, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, {
        agent: agents[url.protocol],
        headers: { ...options.headers, "Accept-Encoding": "identity" },
        signal: AbortSignal.timeout(15000),
      }, resolve);
      request.on("error", reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
      response.resume();
      await new Promise(resolve => response.on("end", resolve));
      if (redirects >= 3) throw new Error("too_many_redirects");
      const next = new URL(response.headers.location, url);
      if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("insecure_redirect");
      return fetchSession(next.href, options, redirects + 1);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value != null) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const body = Readable.toWeb(response);
    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      url: url.href, headers, body,
      text: () => new Response(body).text(),
    };
  }
  return { fetch: fetchSession, close() { Object.values(agents).forEach(agent => agent.destroy()); } };
}

const sessions = new Map();
const tokenStates = new WeakMap();
export function acquireUpstreamSession(targetUrl) {
  const origin = new URL(targetUrl).origin;
  let entry = sessions.get(origin);
  if (!entry) {
    if (sessions.size >= 16) throw new Error("session_capacity");
    entry = { session: createUpstreamSession(), users: 0, timer: null };
    sessions.set(origin, entry);
  }
  clearTimeout(entry.timer);
  entry.users++;
  let released = false;
  return {
    fetch: entry.session.fetch,
    close() {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        entry.timer = setTimeout(() => {
          entry.session.close();
          sessions.delete(origin);
        }, 60000);
        entry.timer.unref();
      }
    },
  };
}

function absoluteUrl(value, base) {
  try { return new URL(value, base).href; } catch { return null; }
}
function stripToken(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete("token");
  return url.href;
}
function extractToken(body) {
  const text = String(body || "").trim();
  if (!text || text.startsWith("<")) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") return parsed.trim();
    return parsed?.token || parsed?.jwt || parsed?.data?.token || parsed?.data?.jwt || null;
  } catch { return text; }
}
async function mintToken(targetUrl, sessionFetch, log) {
  let state = tokenStates.get(sessionFetch);
  if (!state) {
    state = { token: null, expiresAt: 0, pending: null, blockedUntil: 0 };
    tokenStates.set(sessionFetch, state);
  }
  if (state.token && Date.now() < state.expiresAt) return state.token;
  if (Date.now() < state.blockedUntil) {
    const error = new Error("token_rate_limited");
    error.code = "TOKEN_RATE_LIMITED";
    error.retryAfter = Math.ceil((state.blockedUntil - Date.now()) / 1000);
    throw error;
  }
  if (state.pending) return state.pending;
  state.pending = issueToken(targetUrl, sessionFetch, log, state);
  try { return await state.pending; }
  finally { state.pending = null; }
}
async function issueToken(targetUrl, sessionFetch, log, state) {
  const origin = new URL(targetUrl).origin;
  const tokenRes = await sessionFetch(`${origin}/generate.php`, {
    headers: { Accept: "*/*", "User-Agent": UA, Referer: REFERER, "Cache-Control": "no-cache, no-store" },
    redirect: "follow",
  });
  const tokenBody = await tokenRes.text();
  const token = tokenRes.ok ? extractToken(tokenBody) : null;
  log(`[proxy] token status=${tokenRes.status} present=${typeof token === "string" && !!token} cacheAge=${Number(tokenRes.headers.get("age") || 0)}`);
  if (tokenRes.status === 429) {
    const retry = tokenRes.headers.get("retry-after");
    const seconds = /^\d+$/.test(retry || "") ? Number(retry) : Math.ceil((Date.parse(retry) - Date.now()) / 1000);
    const wait = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
    state.blockedUntil = Date.now() + wait * 1000;
    const error = new Error("token_rate_limited");
    error.code = "TOKEN_RATE_LIMITED";
    error.retryAfter = wait;
    throw error;
  }
  if (typeof token !== "string" || !token) throw new Error("token_unavailable");
  state.token = token;
  state.expiresAt = Date.now() + 60000;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (Number.isFinite(payload.exp)) state.expiresAt = Math.min(state.expiresAt, payload.exp * 1000 - 10000);
  } catch { /* Providers may return opaque tokens. */ }
  return token;
}
async function tokenizedTarget(rawTarget, sessionFetch, log) {
  const clean = new URL(stripToken(rawTarget));
  const token = await mintToken(clean.href, sessionFetch, log);
  if (token) clean.searchParams.set("token", token);
  return clean.href;
}
function proxyUrlFor(target, req) {
  const cleanTarget = stripToken(target);
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const sig = signTarget(cleanTarget);
  return `${proto}://${host}/proxy?url=${encodeURIComponent(cleanTarget)}&sig=${sig}`;
}
function rewritePlaylist(text, playlistUrl, req) {
  const rewriteOne = raw => {
    const abs = absoluteUrl(raw, playlistUrl);
    return abs ? proxyUrlFor(abs, req) : raw;
  };
  return text.split(/\r?\n/).map(line => {
    if (!line) return line;
    if (!line.startsWith("#")) return rewriteOne(line.trim());
    return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${rewriteOne(uri)}"`);
  }).join("\n");
}

export function detectMediaType(bytes) {
  if (bytes.length >= 377 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) {
    return "video/mp2t";
  }
  if (
    bytes.length >= 8 &&
    ["ftyp", "styp", "moof"].includes(Buffer.from(bytes.subarray(4, 8)).toString("ascii"))
  ) {
    return "video/mp4";
  }
  return null;
}

export function createHandler({ sessionFactory = acquireUpstreamSession, log = console.info } = {}) {
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-VidSrc-Proxy-Version", "1.1.8");
    if (req.method === "OPTIONS") return res.status(204).end();
    const target = String(req.query.url || "");
    const sig = String(req.query.sig || "");
    if (!verifyTarget(target, sig)) return res.status(403).send("Invalid proxy signature");
    let parsed;
    try {
      parsed = new URL(target);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");
    } catch { return res.status(400).send("Invalid target"); }
    const session = sessionFactory(target);
    let streaming = false;
    try {
      let upstreamUrl;
      try { upstreamUrl = await tokenizedTarget(target, session.fetch, log); }
      catch (error) {
        log(`[proxy] token_request_failed code=${error.code || "request_failed"}`);
        res.setHeader("Retry-After", String(error.retryAfter || 60));
        return res.status(503).send("Video token temporarily unavailable; retry later");
      }
      const headers = { Accept: "*/*", "User-Agent": UA, Referer: REFERER };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await session.fetch(upstreamUrl, { headers, redirect: "follow" });
      if (!upstream.ok && upstream.status !== 206) {
        const text = (await upstream.text()).toLowerCase();
        const reason = /expir/.test(text) ? "expired" : /invalid/.test(text) ? "invalid" : /ip.?address|ip.?mismatch/.test(text) ? "ip_mismatch" : /token/.test(text) ? "token_rejected" : "upstream_rejected";
        log(`[proxy] media status=${upstream.status} kind=${parsed.pathname.endsWith(".m3u8") ? "playlist" : "media"} reason=${reason}`);
        return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
      }
      const finalUrl = upstream.url || upstreamUrl;
      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      const looksHls = contentType.includes("mpegurl") || parsed.pathname.toLowerCase().includes(".m3u8");
      if (looksHls) {
        const text = await upstream.text();
        if (!text.trimStart().startsWith("#EXTM3U")) return res.status(502).send("Invalid upstream playlist");
        res.status(200);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.send(rewritePlaylist(text, finalUrl, req));
      }
      let mediaBody = upstream.body;
      let detectedType = null;

      // Some VidSrc segment hosts incorrectly label real TS/MP4 bytes as text/html.
      // Keep the playback branch intact. Cancelling the probe resolves only when
      // playback consumes or cancels its branch, so do not await it before piping.
      if (mediaBody && contentType.includes("text/html")) {
        const [probeBody, playbackBody] = mediaBody.tee();
        const reader = probeBody.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (size < 377) {
            const part = await reader.read();
            if (part.done) break;
            chunks.push(part.value);
            size += part.value.length;
          }
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }

        detectedType = detectMediaType(Buffer.concat(chunks));
        if (!detectedType) {
          await playbackBody.cancel().catch(() => {});
          return res.status(502).send("Invalid upstream video content");
        }
        mediaBody = playbackBody;
      }

      for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
        const value = upstream.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      if (detectedType) res.setHeader("Content-Type", detectedType);

      res.status(upstream.status);
      if (!mediaBody) return res.end();
      streaming = true;
      res.once("finish", () => session.close());
      res.once("close", () => session.close());
      const source = Readable.fromWeb(mediaBody);
      res.once("close", () => source.destroy());
      source.on("error", () => { session.close(); res.destroy(); });
      return source.pipe(res);
    } catch (error) {
      log(`[proxy] request_failed code=${error.code || "request_failed"}`);
      return res.status(502).send("Upstream request failed");
    } finally { if (!streaming) session.close(); }
  };
}
export default createHandler();
