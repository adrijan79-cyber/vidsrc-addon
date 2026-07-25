import { buildEmbedUrls, parseStreamId } from "../lib/sources.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "public, max-age=1800");

  const { type, id } = req.query;
  if (!type || !id) {
    return res.status(400).json({ streams: [], err: "missing type or id" });
  }

  const parsed = parseStreamId(id);
  if (!parsed) {
    return res.status(200).json({ streams: [] });
  }

  if (type === "movie" && parsed.type !== "movie") {
    return res.status(200).json({ streams: [] });
  }
  if (type === "series" && parsed.type !== "series") {
    return res.status(200).json({ streams: [] });
  }

  const embeds = buildEmbedUrls(parsed);

  const streams = embeds.map(({ name, url }) => ({
    name: "VidSrc",
    title: `${name}\nOpens in browser`,
    externalUrl: url,
    behaviorHints: {
      notWebReady: true,
    },
  }));

  return res.status(200).json({ streams });
}
