# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-29

### Added
- **Local helper engine.** A small native-messaging helper runs llama.cpp on the GPU with the
  most memory, such as the dedicated card in a hybrid machine. Firefox starts it on demand and
  stops it after an idle timeout. Installers for Linux and macOS, and a Nix package for NixOS.
- Engine switch in the popup, with separate model choices per engine (Qwen3 4B/8B and
  Qwen2.5-VL 3B/7B or Qwen3-VL 4B for the helper).
- Streaming: translations appear as they are generated, with a timer. Closing a card cancels
  generation.
- End-to-end test of the extension with the real helper and a fake llama-server.

### Changed
- Images are read first (text in the image, in its original language) and then translated by
  the text model, for any kind of image rather than comics only.
- The result card shows "Text in image" and "Translation" as separate sections.

### Fixed
- The overlay card ignored dark mode.

## [0.1.0] - 2026-10-29

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
