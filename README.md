# AegisTranslate

Private, on-device translation for Firefox: web text and text inside images (manga, comics,
infographics), translated by small Qwen models running locally on your GPU through WebGPU.

- **Off by default.** One switch turns it on; switching it off unloads the models and frees VRAM.
- **Pick your models.** A text model (Qwen3 1.7B or 4B), plus an optional vision model for
  image translation (Qwen2-VL 2B, Qwen3-VL 2B), each downloaded only when you press Download.
- **No translation servers.** Nothing you read is sent anywhere. The only network requests the
  extension makes are model downloads from Hugging Face, which you start yourself.

## Use

- **Text:** select text → right-click → *Translate selection*, or press `Alt+Shift+T`.
- **Images:** hover an image and press *Translate*, or right-click → *Translate image text*.

## Requirements

Firefox 142+ with WebGPU working (check `about:support`). Roughly 2–4 GB of free VRAM
depending on the models you choose.

## Build

```bash
npm install
npm run build    # output in dist/
npm start        # launches Firefox with the extension loaded
npm run package  # zip for addons.mozilla.org
```

## Security model

Page text is passed to the model as delimited data, never merged into the instructions. The
model has no tools, no network and no access to the page; its output is shown as plain text.
A malicious page can therefore at worst produce a wrong translation.

## License

Apache License 2.0. Copyright 2026 Nexoniarz. See `LICENSE`, `NOTICE` and
`THIRD_PARTY_NOTICES.md`. Model weights are not included and have their own licenses.
