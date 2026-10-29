# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Translation of selected text with Qwen3 1.7B or 4B, running locally through WebGPU.
- Image translation with an optional vision model (Qwen2-VL 2B, Qwen3-VL 2B), from a hover
  button or the right-click menu.
- Popup with an on/off switch, target language, and download, load and delete for each model.
- `Alt+Shift+T` shortcut for selected text.
- Interface built with the Niveus design system, in light and dark.
- Logo and icons.

### Security
- ONNX Runtime is patched at build time so it never uses `new Function` or dynamic `import()`,
  and runs under a CSP without `unsafe-eval`. `web-ext lint` reports no warnings.
