# Contributing

Thanks for helping. Bug reports, model suggestions, translations of the UI and pull requests
are all welcome.

## Setup

```bash
git clone https://github.com/Nexoniarz/AegisTranslate.git
cd AegisTranslate
npm install
npm start         # opens Firefox with the extension loaded
```

You need Firefox 142+ with WebGPU working (`about:support` → *WebGPU*).

## Before opening a pull request

- `npm run lint` passes (it runs the build and `web-ext lint`).
- You tried the change in Firefox: popup, selected text and at least one image.
- Both light and dark mode look right.

## Ground rules

- **No new network requests.** Anything that talks to a server needs an issue and discussion
  first, and must be documented in `PRIVACY.md`.
- **No remote code.** Every script and WASM file ships inside the extension.
- **Never insert page or model text as HTML.** Use `textContent`.
- **Style with Niveus.** Use its components and tokens (`--nv-*`). Don't write literal colours,
  shadows or durations; see the [Niveus guidelines](https://github.com/Nexoniarz/Niveus/blob/main/GUIDELINES.md).
  Update `vendor/niveus/` from upstream only, never by hand.

## Adding a model

Add an entry to `src/models.js` with the ONNX repo id and dtype. In the pull request, say which
GPU you tested on, the download size, and how quality compares with the existing models.

## Commit messages

Short imperative subject (`Add Korean to target languages`), with a body explaining why if it
isn't obvious.
