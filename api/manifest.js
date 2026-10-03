import { manifest } from "../lib/manifest.js";

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.status(200).json(manifest);
}
