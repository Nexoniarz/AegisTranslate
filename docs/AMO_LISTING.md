# addons.mozilla.org listing (draft)

**Name:** AegisTranslate

**Summary** (≤ 250 characters):
Private, on-device translation for Firefox, including text inside images. Qwen models run on
your GPU through WebGPU; nothing you read is sent to a server.

**Categories:** Language Support · Privacy & Security

**Description:**

Translate selected text and the text inside images (screenshots, signs, scans, comics, charts)
without sending anything to a translation service.

- Select text and right-click → Translate selection, or press Alt+Shift+T.
- Hover an image and click Translate: you get the text found in the image and its translation.
- Translations stream in word by word. Closing the card stops the work.
- Two engines: In browser (Transformers.js on WebGPU, nothing to install), or the optional
  local helper, which runs llama.cpp on your most powerful GPU, such as the dedicated card in
  a hybrid laptop or desktop, without changing how Firefox itself runs. Firefox starts the
  helper when needed and stops it when idle.
- One switch turns it off and frees GPU memory.

Everything runs on your device. The only network requests are model downloads from Hugging
Face, which you start yourself. Requires Firefox 142+, and WebGPU or the local helper, with
2–6 GB of free VRAM depending on the models.

Open source under Apache 2.0: https://github.com/Nexoniarz/AegisTranslate

**Privacy policy:** paste `PRIVACY.md`.

## Notes for reviewers

The package contains bundled, minified code. To reproduce it:

```bash
npm ci
npm run build     # output in dist/, identical to the submitted package
```

Upload `web-ext-artifacts/aegistranslate-source.zip` (made by `npm run package:source`, a
`git archive` of the tagged commit) as the source code.

- Node 22, npm 10. The build is `build.mjs` (esbuild).
- `background.js` bundles Transformers.js (Apache-2.0) and ONNX Runtime Web (MIT).
- `vendor/ort-wasm-simd-threaded.asyncify.wasm` is copied unchanged from
  `node_modules/onnxruntime-web/dist/`.
- Two small build-time patches make ONNX Runtime work under the extension's CSP without
  `unsafe-eval` (see `src/vendor/ort-patches.js`): Embind's `new Function` method invoker is
  replaced with an equivalent closure (covered by `npm test`), and the runtime's
  `import(url)` of its WASM glue is replaced with a static import, so all code is bundled.
- `vendor/niveus/` is the Niveus CSS design system, unchanged.
- No remote code: `wasmPaths` points at the packaged files, and model downloads contain
  weights only (ONNX and JSON).
- `nativeMessaging` is an optional permission, requested only when the user chooses the
  "Local helper" engine. The helper is a separate, open-source Python script
  (`helper/aegistranslate_helper.py`) that the user installs themselves; it is not part of the
  package. Only this add-on's ID is allowed to start it.
