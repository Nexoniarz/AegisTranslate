import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

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
cpSync("LICENSE", `${out}/LICENSE`);
cpSync("THIRD_PARTY_NOTICES.md", `${out}/THIRD_PARTY_NOTICES.md`);
