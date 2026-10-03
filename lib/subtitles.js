import { signTarget } from "./proxy-sign.js";

export function isSubtitleUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "vidapi.cloud" &&
      !url.username && !url.password && !url.port && url.pathname.startsWith("/subs/") &&
      /\.(srt|vtt|ass|ssa)$/i.test(url.pathname);
  } catch { return false; }
}

export function buildSubtitleList(items, req) {
  if (!Array.isArray(items)) return [];
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const seen = new Set();
  return items.flatMap((item, index) => {
    if (!isSubtitleUrl(item?.url) || seen.has(item.url)) return [];
    seen.add(item.url);
    const path = new URL(item.url).pathname;
    const lang = path.match(/\.([a-z]{3})\.(?:srt|vtt|ass|ssa)$/i)?.[1]?.toLowerCase() || item.code || item.lang || "und";
    const ext = path.split(".").pop().toLowerCase();
    return [{
      id: `vidsrc-${lang}-${index}`,
      lang,
      label: String(item.lang || lang),
      url: `${proto}://${host}/subtitle/caption.${ext}?url=${encodeURIComponent(item.url)}&sig=${signTarget(item.url)}`,
    }];
  });
}
