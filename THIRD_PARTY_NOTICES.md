# Third-party software

| Component | License | Source |
|---|---|---|
| @huggingface/transformers (Transformers.js) | Apache-2.0 | https://github.com/huggingface/transformers.js |
| onnxruntime-web (ONNX Runtime) | MIT | https://github.com/microsoft/onnxruntime |
| Niveus design system | Apache-2.0 | https://github.com/Nexoniarz/Niveus (`vendor/niveus/VERSION` has the commit) |
| Instrument Sans (font, via Niveus) | SIL OFL 1.1 | `vendor/niveus/fonts/OFL-InstrumentSans.txt` |
| JetBrains Mono (font, via Niveus) | SIL OFL 1.1 | `vendor/niveus/fonts/OFL-JetBrainsMono.txt` |

llama.cpp (MIT, https://github.com/ggml-org/llama.cpp) is used by the optional local helper but
is not bundled; users install it themselves.

Model weights are not bundled. They are downloaded on request and carry their own licenses
(Qwen models: see each model card on Hugging Face).
