import { buildEmbedUrls, parseStreamId } from "../lib/sources.js";
import { scrapeVidsrcM3u8 } from "../lib/scrape-vidsrc.js";

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
    const scraped = await scrapeVidsrcM3u8(parsed);
    if (scraped?.m3u8) {
      streams.push({
        name: "VidSrc",
        title: "vidsrc.xyz\nNative HLS · in-app playback",
        url: scraped.m3u8,
        behaviorHints: {
          notWebReady: false,
          proxyHeaders: {
            request: {
              Referer: scraped.referer,
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
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
