import { verifyTarget } from "../lib/proxy-sign.js";
import { isSubtitleUrl } from "../lib/subtitles.js";
import { UA, REFERER } from "../lib/vidsrc-direct.js";

export function createSubtitleHandler(fetchImpl = fetch) {
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(204).end();
    const url = String(req.query.url || "");
    if (!verifyTarget(url, String(req.query.sig || "")) || !isSubtitleUrl(url)) return res.status(403).send("Invalid subtitle request");
    try {
      const upstream = await fetchImpl(url, {
        headers: { "User-Agent": UA, Referer: REFERER },
        signal: AbortSignal.timeout(10000), redirect: "error",
      });
      if (!upstream.ok) return res.status(502).send("Subtitle unavailable");
      const reader = upstream.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 2 * 1024 * 1024) throw new Error("subtitle_too_large");
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      const ext = new URL(url).pathname.split(".").pop().toLowerCase();
      const valid = ext === "vtt" ? text.startsWith("WEBVTT") : ["ass", "ssa"].includes(ext)
        ? /^\[Script Info\]/m.test(text) : /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text);
      if (!valid || /^\s*</.test(text)) return res.status(502).send("Invalid subtitle content");
      const types = { srt: "application/x-subrip", vtt: "text/vtt", ass: "text/x-ssa", ssa: "text/x-ssa" };
      res.setHeader("Content-Type", `${types[ext]}; charset=utf-8`);
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).send(text);
    } catch { return res.status(502).send("Subtitle request failed"); }
  };
}
export default createSubtitleHandler();
