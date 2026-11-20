import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";

const root = import.meta.dirname;
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("The widget package version must use X.Y.Z format");
}
const tag = process.env.WIDGET_RELEASE_TAG;
const configuredOrigin = process.env.WIDGET_ASSET_ORIGIN;
if (tag && (tag !== `widget-v${version}` || !configuredOrigin)) {
  throw new Error(`Release requires tag widget-v${version} and WIDGET_ASSET_ORIGIN`);
}
const assetOrigin = new URL(configuredOrigin || "https://assets.example.invalid");
if (assetOrigin.protocol !== "https:" || assetOrigin.href !== `${assetOrigin.origin}/`) {
  throw new Error("WIDGET_ASSET_ORIGIN must be a bare HTTPS origin");
}
if (tag && assetOrigin.hostname.endsWith(".invalid")) {
  throw new Error("Release requires a real asset origin");
}

const assetPath = `/widget/v${version}/`;
const dist = resolve(root, "dist");
const outDir = resolve(dist, `widget/v${version}`);
const integrity = bytes => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
const css = await readFile(resolve(root, "src/widget.css"));
const cssIntegrity = integrity(css);

await build({
  root,
  configFile: false,
  publicDir: false,
  define: { __WIDGET_CSS_INTEGRITY__: JSON.stringify(cssIntegrity) },
  build: {
    target: "es2022",
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(root, "src/index.ts"), name: "AiTuslahEmbed", formats: ["iife"], fileName: () => "widget.js" },
  },
});

const scriptUrl = new URL(`${assetPath}widget.js`, assetOrigin).href;
const scriptIntegrity = integrity(await readFile(resolve(outDir, "widget.js")));
const manifest = {
  version,
  assets: {
    script: { url: scriptUrl, integrity: scriptIntegrity },
    css: { url: new URL(`${assetPath}widget.css`, assetOrigin).href, integrity: cssIntegrity },
  },
};

await Promise.all([
  writeFile(resolve(outDir, "widget.css"), css),
  writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  writeFile(resolve(dist, "install.html"), `<script defer src="${scriptUrl}" integrity="${scriptIntegrity}" crossorigin="anonymous"></script>\n`),
  copyFile(resolve(root, "../../docs/widget-install.md"), resolve(dist, "widget-install.md")),
]);
