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
    return (
      parsed?.token ||
      parsed?.jwt ||
      parsed?.data?.token ||
      parsed?.data?.jwt ||
      null
    );
  } catch {
    return text;
  }
}

async function mintToken(targetUrl) {
  const origin = new URL(targetUrl).origin;
  const tokenRes = await fetch(`${origin}/generate.php`, {
    headers: {
      Accept: "*/*",
      "User-Agent": UA,
      Referer: REFERER,
    },
    redirect: "follow",
  });

  if (!tokenRes.ok) return null;
  return extractToken(await tokenRes.text());
}

async function tokenizedTarget(rawTarget) {
  const clean = new URL(stripToken(rawTarget));
  const token = await mintToken(clean.href);
  if (!token) return clean.href;
  clean.searchParams.set("token", token);
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
  const rewriteOne = (raw) => {
    const abs = absoluteUrl(raw, playlistUrl);
    if (!abs) return raw;
    // Never carry an old IP-bound token into another Vercel invocation.
    // The child /proxy request will mint a fresh token for its own egress IP.
    return proxyUrlFor(abs, req);
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
  res.setHeader("Cache-Control", "no-store");

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

  // VidSrc tokens are short-lived and IP-bound. Vercel does not guarantee
  // the same outbound IP across separate serverless invocations, so mint the
  // token here, in the same invocation that fetches the playlist/segment.
  let upstreamUrl;
  try {
    upstreamUrl = await tokenizedTarget(target);
  } catch {
    upstreamUrl = stripToken(target);
  }

  const headers = {
    Accept: "*/*",
    "User-Agent": UA,
    Referer: REFERER,
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(upstreamUrl, {
    headers,
    redirect: "follow",
  });

  if (!upstream.ok && upstream.status !== 206) {
    return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
  }

  const finalUrl = upstream.url || upstreamUrl;
  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const looksHls =
    contentType.includes("mpegurl") ||
    parsed.pathname.toLowerCase().includes(".m3u8");

  if (looksHls) {
    const text = await upstream.text();
    const rewritten = text.trimStart().startsWith("#EXTM3U")
      ? rewritePlaylist(text, finalUrl, req)
      : text;

    res.status(200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
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
