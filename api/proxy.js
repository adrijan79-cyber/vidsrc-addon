import { Readable } from "node:stream";
import { signTarget, verifyTarget } from "../lib/proxy-sign.js";
import { REFERER, UA } from "../lib/vidsrc-direct.js";

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
}

function carryToken(childUrl, parentUrl) {
  try {
    const child = new URL(childUrl);
    const parent = new URL(parentUrl);
    const token = parent.searchParams.get("token");
    if (token && !child.searchParams.has("token")) child.searchParams.set("token", token);
    return child.href;
  } catch {
    return childUrl;
  }
}

function proxyUrlFor(target, req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const sig = signTarget(target);
  return `${proto}://${host}/proxy?url=${encodeURIComponent(target)}&sig=${sig}`;
}

function rewritePlaylist(text, playlistUrl, req) {
  const rewriteOne = (raw) => {
    const abs = absoluteUrl(raw, playlistUrl);
    if (!abs) return raw;
    return proxyUrlFor(carryToken(abs, playlistUrl), req);
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (!line.startsWith("#")) return rewriteOne(line.trim());

      return line.replace(/URI="([^"]+)"/g, (_m, uri) => {
        return `URI="${rewriteOne(uri)}"`;
      });
    })
    .join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const target = String(req.query.url || "");
  const sig = String(req.query.sig || "");
  if (!verifyTarget(target, sig)) {
    return res.status(403).send("Invalid proxy signature");
  }

  let parsed;
  try {
    parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");
  } catch {
    return res.status(400).send("Invalid target");
  }

  const headers = {
    Accept: "*/*",
    "User-Agent": UA,
    Referer: REFERER,
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(target, {
    headers,
    redirect: "follow",
  });

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const looksHls =
    contentType.includes("mpegurl") ||
    parsed.pathname.toLowerCase().includes(".m3u8");

  if (looksHls) {
    const text = await upstream.text();
    const rewritten = text.trimStart().startsWith("#EXTM3U")
      ? rewritePlaylist(text, target, req)
      : text;
    res.status(200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store");
    return res.send(rewritten);
  }

  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const key of passthrough) {
    const value = upstream.headers.get(key);
    if (value) res.setHeader(key, value);
  }
  res.status(upstream.status);

  if (!upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
}
