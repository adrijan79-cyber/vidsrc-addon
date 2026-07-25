const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const TIMEOUT_MS = 4500;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function absoluteUrl(url, baseHost) {
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return `https://${baseHost}${url}`;
  return `https://${baseHost}/${url}`;
}

function pickPlayerIframe(html) {
  const iframes = [...html.matchAll(/<iframe[^>]*src=["']([^"']+)["']/gi)].map(
    (m) => m[1]
  );
  return (
    iframes.find((src) => /cloudnestra|rcp|player_iframe/i.test(src)) ??
    iframes[0] ??
    null
  );
}

export async function scrapeVidsrcM3u8({ type, imdbId, season, episode }) {
  const embed =
    type === "series"
      ? `https://vidsrc.xyz/embed/tv/${imdbId}/${season}-${episode}`
      : `https://vidsrc.xyz/embed/movie/${imdbId}`;

  const baseHeaders = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };

  const r1 = await fetchWithTimeout(embed, { headers: baseHeaders });
  if (!r1.ok) return null;
  const html1 = await r1.text();

  const iframe1 = pickPlayerIframe(html1);
  if (!iframe1) return null;
  const rcpUrl = absoluteUrl(iframe1, "vidsrc.xyz");
  const rcpHost = new URL(rcpUrl).host;

  const r2 = await fetchWithTimeout(rcpUrl, {
    headers: { ...baseHeaders, Referer: embed },
  });
  if (!r2.ok) return null;
  const html2 = await r2.text();

  const prorcpMatch = html2.match(
    /src\s*[:=]\s*['"]([^'"]*prorcp\/[^'"]+)['"]/i
  );
  if (!prorcpMatch) return null;
  const prorcpUrl = absoluteUrl(prorcpMatch[1], rcpHost);

  const r3 = await fetchWithTimeout(prorcpUrl, {
    headers: { ...baseHeaders, Referer: rcpUrl },
  });
  if (!r3.ok) return null;
  const html3 = await r3.text();

  const fileMatch =
    html3.match(/file\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i) ??
    html3.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/i);
  if (!fileMatch) return null;

  return { m3u8: fileMatch[1], referer: prorcpUrl };
}
