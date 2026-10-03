import { createHmac, timingSafeEqual } from "node:crypto";

function secret() {
  const value = process.env.TMDB_API_KEY;
  if (!value) throw new Error("TMDB_API_KEY is required for proxy signing");
  return value;
}

export function signTarget(target) {
  return createHmac("sha256", secret()).update(String(target)).digest("hex");
}

export function verifyTarget(target, signature) {
  if (!target || !signature) return false;
  const expected = signTarget(target);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
