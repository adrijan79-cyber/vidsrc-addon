import { buildEmbedUrls, parseStreamId } from "../lib/sources.js";
import { resolveVidSrc } from "../lib/vidsrc-direct.js";
import { signTarget } from "../lib/proxy-sign.js";
import { buildSubtitleList } from "../lib/subtitles.js";

function addonBase(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${host}`;
}

function stripToken(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete("token");
  return url.href;
}

function proxiedUrl(target, req) {
  const cleanTarget = stripToken(target);
  const sig = signTarget(cleanTarget);
  return `${addonBase(req)}/proxy?url=${encodeURIComponent(cleanTarget)}&sig=${sig}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-store");

  const { type, id } = req.query;
  if (!type || !id) {
    return res.status(400).json({ streams: [], err: "missing type or id" });
  }

  const parsed = parseStreamId(id);
  if (!parsed) return res.status(200).json({ streams: [] });
  if (type !== parsed.type) return res.status(200).json({ streams: [] });

  const streams = [];

  try {
    const result = await resolveVidSrc(parsed);
    const subtitles = buildSubtitleList(result.subtitles, req);

    for (const [index, rawUrl] of result.urls.entries()) {
      try {
        streams.push({
          name: `VidSrc Direct ${index + 1}`,
          title: `${result.title || "VidSrc"} · Native HLS · Server ${index + 1}`,
          // The proxy shares a short-lived token on its upstream session.
          url: proxiedUrl(rawUrl, req),
          subtitles,
          behaviorHints: {
            notWebReady: true,
            ...(result.filename ? { filename: result.filename } : {}),
          },
        });
      } catch {
        // One malformed CDN URL should not hide the others.
      }
    }
  } catch {
    // Direct resolver failed — keep browser mirrors as last-resort fallback.
  }

  for (const { name, url } of buildEmbedUrls(parsed)) {
    streams.push({
      name: "VidSrc",
      title: `${name}\nOpens in browser`,
      externalUrl: url,
      behaviorHints: { notWebReady: true },
    });
  }

  return res.status(200).json({ streams });
}
