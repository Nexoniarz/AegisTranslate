// Model catalogs for the two engines.
//
// browser: ONNX models run by Transformers.js on WebGPU inside Firefox.
// helper:  GGUF models run by llama.cpp in the local helper, on the best GPU.
//          `hf` is passed to llama-server -hf (repo[:quant]); it downloads the
//          model, and the vision projector where there is one, on first use.
//
// Entries marked `verify: true` have not been tested yet; confirm they load before release.

export const ENGINES = {
  browser: "In browser",
  helper: "Local helper",
};

export const CATALOG = {
  browser: {
    text: {
      "qwen3-1.7b": {
        label: "Qwen3 1.7B (fast, ~1.3 GB)",
        id: "onnx-community/Qwen3-1.7B-ONNX",
        dtype: "q4f16",
      },
      "qwen3-4b": {
        label: "Qwen3 4B (better, ~2.8 GB)",
        id: "onnx-community/Qwen3-4B-ONNX",
        dtype: "q4f16",
        verify: true,
      },
    },
    vision: {
      "qwen2-vl-2b": {
        label: "Qwen2-VL 2B (~1.6 GB)",
        id: "onnx-community/Qwen2-VL-2B-Instruct",
        dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4f16" },
      },
      "qwen3-vl-2b": {
        label: "Qwen3-VL 2B (~1.8 GB)",
        id: "onnx-community/Qwen3-VL-2B-Instruct-ONNX",
        dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4f16" },
        verify: true,
      },
    },
  },
  helper: {
    text: {
      "qwen3-4b": { label: "Qwen3 4B (~2.5 GB)", hf: "Qwen/Qwen3-4B-GGUF:Q4_K_M" },
      "qwen3-8b": { label: "Qwen3 8B (best, ~5 GB)", hf: "Qwen/Qwen3-8B-GGUF:Q4_K_M" },
    },
    vision: {
      "qwen2.5-vl-3b": { label: "Qwen2.5-VL 3B (~3 GB)", hf: "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M" },
      "qwen3-vl-4b": { label: "Qwen3-VL 4B (~3.3 GB)", hf: "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M", verify: true },
      "qwen2.5-vl-7b": { label: "Qwen2.5-VL 7B (best reading, ~6 GB)", hf: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M" },
    },
  },
};

export const LANGUAGES = [
  "English", "Polish", "German", "French", "Spanish", "Portuguese", "Italian", "Dutch",
  "Ukrainian", "Russian", "Czech", "Swedish", "Finnish", "Turkish", "Greek", "Arabic",
  "Hebrew", "Persian", "Hindi", "Bengali", "Indonesian", "Vietnamese", "Thai",
  "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)",
];

export const IDLE_CHOICES = [
  [1, "1 minute"],
  [5, "5 minutes"],
  [15, "15 minutes"],
  [60, "1 hour"],
];

export const DEFAULT_SETTINGS = {
  enabled: false,
  engine: "browser",
  targetLang: "English",
  visionEnabled: false,
  hoverChip: true,
  showOriginal: true,
  maxImageSide: 1024,
  // Selected model per engine and kind.
  models: {
    browser: { text: "qwen3-1.7b", vision: "qwen2-vl-2b" },
    helper: { text: "qwen3-4b", vision: "qwen2.5-vl-3b" },
  },
  // Minutes without a request before the helper is stopped and its VRAM freed.
  helperIdleMinutes: 5,
  // Browser-engine model IDs whose files are already in the local cache.
  downloaded: {},
};

export function selectedModel(settings, kind, engine = settings.engine) {
  const key = settings.models?.[engine]?.[kind] ?? DEFAULT_SETTINGS.models[engine][kind];
  const spec = CATALOG[engine][kind][key];
  return spec ? { key, ...spec } : null;
}
