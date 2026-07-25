export default function handler(req, res) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const manifestUrl = `${proto}://${host}/manifest.json`;
  const stremioDeepLink = `stremio://${host}/manifest.json`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>VidSrc Addon</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d12; color: #e6e8ee; margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 2rem; }
    .card { max-width: 480px; width: 100%; background: #151923; border: 1px solid #232936; border-radius: 14px; padding: 2rem; }
    h1 { margin: 0 0 .25rem; font-size: 1.6rem; }
    p { color: #a4acbd; line-height: 1.55; margin: .5rem 0 1.25rem; }
    a.button { display: block; text-align: center; text-decoration: none; padding: .85rem 1rem; border-radius: 10px; font-weight: 600; margin-top: .6rem; }
    .primary { background: #7c5cff; color: white; }
    .secondary { background: #232936; color: #e6e8ee; }
    code { background: #0b0d12; padding: .1rem .35rem; border-radius: 4px; font-size: .9em; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h1>VidSrc</h1>
    <p>Stremio addon serving vidsrc mirrors for movies and TV shows. Faster than torrents — streams open in your browser.</p>
    <a class="button primary" href="${stremioDeepLink}">Install in Stremio</a>
    <a class="button secondary" href="${manifestUrl}">Copy manifest URL</a>
    <p style="margin-top:1.25rem;font-size:.85rem;">Manifest: <code>${manifestUrl}</code></p>
  </div>
</body>
</html>`);
}
