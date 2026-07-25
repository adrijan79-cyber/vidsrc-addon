const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export async function imdbToTmdb({ imdbId, type }) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const cacheKey = `${type}:${imdbId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.id;

  const url = `https://api.themoviedb.org/3/find/${imdbId}?external_source=imdb_id&api_key=${apiKey}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);

  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const bucket = type === "series" ? "tv_results" : "movie_results";
    const id = data?.[bucket]?.[0]?.id;
    if (!id) return null;
    cache.set(cacheKey, { id: String(id), at: Date.now() });
    return String(id);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
