# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Small vision models could get stuck repeating the same words on dense images (comic pages)
  until the token limit, which also made image translation slow. Generation is now stopped as
  soon as the output loops, and the repetition is cut. The image prompt also explains how to read
  vertical text.
- The popup showed raw llama-server log lines while a model started.
- The local helper picked the integrated GPU on desktops and laptops with an AMD or Intel APU,
  because integrated GPUs report shared system RAM (for example 25 GB for a Radeon Vega 8 next
  to an 8 GB RTX 3060 Ti). Dedicated GPUs are now preferred, and software renderers are skipped.

### Added
- **Whole-page translation**: right-click → *Translate page*, a button in the popup, or
  `Alt+Shift+P`. The page is translated in place, block by block, starting with what's on screen
  and continuing as you scroll; content the page adds later is translated too. Links and
  formatting keep their translated words, code and `translate="no"` are skipped, and *Show
  original* restores the page.
- Download progress for the local helper, in the popup (with a progress bar) and in the result
  card. llama-server prints none when it isn't on a terminal, so large downloads looked stuck.
- NixOS guide (`docs/NIXOS.md`): configuration.nix, flakes, Home Manager, CUDA, hybrid graphics
  and troubleshooting.
- `npm run package:source` makes the source archive for addons.mozilla.org review.

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
