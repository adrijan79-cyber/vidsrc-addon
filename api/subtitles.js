import { parseStreamId } from "../lib/sources.js";
import { fetchVidSrcPayload } from "../lib/vidsrc-direct.js";
import { buildSubtitleList } from "../lib/subtitles.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  const parsed = parseStreamId(req.query.id);
  if (!parsed || req.query.type !== parsed.type) return res.status(200).json({ subtitles: [] });
  try {
    const payload = await fetchVidSrcPayload(parsed);
    return res.status(200).json({ subtitles: buildSubtitleList(payload.default_subs, req) });
  } catch {
    return res.status(200).json({ subtitles: [] });
  }
}
