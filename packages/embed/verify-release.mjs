import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPath = process.argv[2] ?? resolve(import.meta.dirname, "dist/manifest.json");
const { assets } = JSON.parse(await readFile(manifestPath, "utf8"));

await Promise.all([
  verifyAsset(assets.script, /^(text|application)\/(javascript|ecmascript)(?:\s*;|$)/i),
  verifyAsset(assets.css, /^text\/css(?:\s*;|$)/i),
]);

async function verifyAsset(asset, mimeType) {
  const url = new URL(asset.url);
  if (url.protocol !== "https:") throw new Error(`Expected HTTPS for ${url.href}`);

  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url.href} returned HTTP ${response.status}`);
  if (!mimeType.test(response.headers.get("content-type") ?? "")) throw new Error(`Unexpected content type for ${url.href}`);
  if (response.headers.get("access-control-allow-origin") !== "*") throw new Error(`Missing public CORS header for ${url.href}`);

  const digest = createHash("sha384").update(Buffer.from(await response.arrayBuffer())).digest("base64");
  if (`sha384-${digest}` !== asset.integrity) throw new Error(`Integrity mismatch for ${url.href}`);
  console.log(`Verified ${url.href}`);
}
