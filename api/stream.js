import { buildEmbedUrls, parseStreamId } from "../lib/sources.js";
import { resolveVidSrc, REFERER, UA } from "../lib/vidsrc-direct.js";
import { signTarget } from "../lib/proxy-sign.js";

function addonBase(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${host}`;
}

async function fetchPlaybackToken(streamUrl) {
  const origin = new URL(streamUrl).origin;
  const tokenUrl = `${origin}/generate.php`;

  const response = await fetch(tokenUrl, {
    headers: {
      Accept: "*/*",
      "User-Agent": UA,
      Referer: REFERER,
    },
    redirect: "follow",
  });

  if (!response.ok) return null;
  const body = (await response.text()).trim();
  if (!body || body.startsWith("<")) return null;

  try {
    const parsed = JSON.parse(body);
    return parsed?.token || parsed?.jwt || parsed?.data?.token || body;
  } catch {
    return body;
  }
}

function withToken(streamUrl, token) {
  const url = new URL(streamUrl);
  if (token) url.searchParams.set("token", token);
  return url.href;
}

function proxiedUrl(target, req) {
  const sig = signTarget(target);
  return `${addonBase(req)}/proxy?url=${encodeURIComponent(target)}&sig=${sig}`;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  // VidSrc playback tokens are short-lived. Do not cache stream responses.
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

    for (const rawUrl of result.urls) {
      try {
        const token = await fetchPlaybackToken(rawUrl);
        const playable = withToken(rawUrl, token);
        streams.push({
          name: "VidSrc Direct",
          title: `${result.title || "VidSrc"} · Native HLS`,
          // Keep playlist + segments on the same Vercel egress IP that minted
          // the upstream token, and rewrite the HLS tree through /proxy.
          url: proxiedUrl(playable, req),
          behaviorHints: {
            notWebReady: true,
          },
        });
      } catch {
        // One CDN failed; keep trying any other resolved URLs.
      }
    }
  } catch {
    // Direct resolver failed — browser mirrors remain as a last-resort fallback.
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
