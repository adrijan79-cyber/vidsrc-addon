const MIRRORS = [
  { name: "VidSrc.xyz", host: "vidsrc.xyz" },
  { name: "VidSrc.to", host: "vidsrc.to" },
  { name: "VidSrc.me", host: "vidsrc.me" },
  { name: "VidSrc.pm", host: "vidsrc.pm" },
  { name: "VidSrc.in", host: "vidsrc.in" },
  { name: "VidSrc.net", host: "vidsrc.net" },
];

export function buildEmbedUrls({ type, imdbId, season, episode }) {
  return MIRRORS.map(({ name, host }) => {
    const base = `https://${host}/embed`;
    const url =
      type === "series"
        ? `${base}/tv/${imdbId}/${season}-${episode}`
        : `${base}/movie/${imdbId}`;
    return { name, url };
  });
}

export function parseStreamId(rawId) {
  const decoded = decodeURIComponent(rawId).replace(/\.json$/, "");
  const parts = decoded.split(":");
  const imdbId = parts[0];
  if (!imdbId || !imdbId.startsWith("tt")) return null;

  if (parts.length === 1) {
    return { type: "movie", imdbId };
  }
  if (parts.length === 3) {
    const season = Number(parts[1]);
    const episode = Number(parts[2]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
    return { type: "series", imdbId, season, episode };
  }
  return null;
}
