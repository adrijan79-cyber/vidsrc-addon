import { scrapeVidsrc } from "@definisi/vidsrc-scraper";
import { buildEmbedUrls, parseStreamId } from "../lib/sources.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "public, max-age=1800");

  const { type, id } = req.query;
  if (!type || !id) {
    return res.status(400).json({ streams: [], err: "missing type or id" });
  }

  const parsed = parseStreamId(id);
  if (!parsed) return res.status(200).json({ streams: [] });
  if (type !== parsed.type) return res.status(200).json({ streams: [] });

  const streams = [];

  try {
    const libType = parsed.type === "series" ? "tv" : "movie";
    const season = parsed.season != null ? String(parsed.season) : null;
    const episode = parsed.episode != null ? String(parsed.episode) : null;

    const result = await scrapeVidsrc(parsed.imdbId, libType, season, episode, {
      timeout: 6000,
      cacheTtl: 1800,
    });

    if (result?.success && result.hlsUrl) {
      streams.push({
        name: "VidSrc",
        title: "Native HLS · in-app playback",
        url: result.hlsUrl,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              Referer: "https://cloudnestra.com/",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
            },
          },
        },
      });
    }
  } catch {
    // scraper failed — fall through to browser mirrors
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
