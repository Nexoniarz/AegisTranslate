// Model catalog. Every entry is an ONNX repo that Transformers.js can load with WebGPU.
// IDs marked `verify: true` have not been tested yet; confirm they exist and load before release.

export const TEXT_MODELS = {
  "qwen3-1.7b": {
    label: "Qwen3 1.7B (lite, ~1.3 GB)",
    id: "onnx-community/Qwen3-1.7B-ONNX",
    dtype: "q4f16",
    thinking: true,
  },
  "qwen3-4b": {
    label: "Qwen3 4B (best quality, ~2.8 GB)",
    id: "onnx-community/Qwen3-4B-ONNX",
    dtype: "q4f16",
    thinking: true,
    verify: true,
  },
};

export const VISION_MODELS = {
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
};

export const LANGUAGES = [
  "English", "Polish", "German", "French", "Spanish", "Portuguese", "Italian", "Dutch",
  "Ukrainian", "Russian", "Czech", "Swedish", "Finnish", "Turkish", "Greek", "Arabic",
  "Hebrew", "Persian", "Hindi", "Bengali", "Indonesian", "Vietnamese", "Thai",
  "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)",
];

export const DEFAULT_SETTINGS = {
  enabled: false,
  targetLang: "English",
  textModel: "qwen3-1.7b",
  visionEnabled: false,
  visionModel: "qwen2-vl-2b",
  hoverChip: true,
  showOriginal: true,
  maxImageSide: 896,
  // Model IDs whose files are already in the local cache.
  downloaded: {},
};

export function resolveModel(kind, key) {
  const table = kind === "vision" ? VISION_MODELS : TEXT_MODELS;
  return table[key] ?? null;
}
