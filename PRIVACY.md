# Privacy policy

_Last updated: 29 October 2026_

AegisTranslate translates text and images **on your device**. This policy covers everything
the extension does with data.

## What the extension does not do

- It does not send page text, images or translations to any server.
- It has no analytics, telemetry, crash reporting or advertising.
- It has no accounts and does not store any identifier for you.

## Network requests

The extension makes exactly two kinds of requests:

1. **Model downloads.** When you press **Download** or **Load** in the popup, or the first time
   the local helper loads a model, model files are fetched from `huggingface.co`. Hugging Face
   sees an ordinary file download (your IP address and client), as with any website. Nothing
   about the pages you read is included.
2. **Re-reading an image you asked to translate.** If the page's own copy of an image can't be
   read (cross-origin), the extension requests the same image URL again so it can read the
   pixels. The browser usually serves this from its cache. The request goes only to the site
   that already served the image.

## The optional local helper

If you choose **Engine → Local helper**, the extension asks Firefox for permission to talk to a
program on your computer (`nativeMessaging`). Firefox then starts the helper when you translate
something and passes text and images to it through a pipe (stdin/stdout). The helper runs
llama.cpp's `llama-server` bound to `127.0.0.1`, which is reachable only from your own machine,
and stops it when Firefox disconnects. The helper sends nothing over the network except the
model downloads described above.

## Data stored on your device

- Your settings (on/off, language, chosen models), in extension storage.
- Downloaded model files: in the browser's cache for the *In browser* engine, and in
  llama.cpp's cache (usually `~/.cache/llama.cpp`) for the local helper.

Both stay on your device. **Delete** in the popup removes a model's files; removing the
extension removes everything.

## Permissions

| Permission | Why |
|---|---|
| Access to all websites | Show the Translate button and result cards on any page, and re-read images you choose to translate. |
| `menus` | The right-click *Translate* entries. |
| `storage`, `unlimitedStorage` | Keep your settings and model files (1–3 GB) locally. |
| `nativeMessaging` (optional) | Asked for only when you choose the local helper. Lets Firefox start it. |

## Contact

Open an issue at https://github.com/Nexoniarz/AegisTranslate/issues.
