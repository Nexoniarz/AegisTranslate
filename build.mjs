import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/vendor`, { recursive: true });

await build({
  entryPoints: ["src/background.js", "src/popup.js", "src/content.js"],
  outdir: out,
  bundle: true,
  format: "esm",
  target: "firefox142",
  // Use the ONNX runtime build that loads its WASM from files we ship,
  // instead of the variant that pulls code from a CDN or embeds blobs.
  conditions: ["onnxruntime-web-use-extern-wasm"],
  legalComments: "linked",
  logLevel: "info",
});

cpSync("static", out, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `${out}/vendor/${f}`);
}

// Niveus, used as-is by the popup.
cpSync("vendor/niveus", `${out}/vendor/niveus`, { recursive: true });

// The in-page overlay lives in a shadow root on someone else's page, where
// :root does not match and rem follows the page's font size. Scope the tokens
// to :host and pin rem to the 16px Niveus is designed at. Fonts are left out:
// @font-face does not apply inside a shadow root, and adding it to the page
// would make the extension visible to page scripts.
const niveus = readFileSync("vendor/niveus/dist/niveus.css", "utf8");
const shadow = niveus
  .replace(/@font-face\s*{[^}]*}/g, "")
  .replace(/:root(?![\w[-])/g, ":root, :host")
  .replace(/:root\[data-theme="(light|dark)"\]/g, ':host([data-theme="$1"])')
  .replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => `${+(n * 16).toFixed(3)}px`);
writeFileSync(`${out}/niveus-shadow.css`, shadow);

cpSync("LICENSE", `${out}/LICENSE`);
cpSync("THIRD_PARTY_NOTICES.md", `${out}/THIRD_PARTY_NOTICES.md`);
