// In-browser engine: ONNX models run by Transformers.js on WebGPU.
import {
  env,
  AutoTokenizer,
  AutoModelForCausalLM,
  AutoProcessor,
  AutoModelForImageTextToText,
  InterruptableStoppingCriteria,
  RawImage,
  TextStreamer,
} from "@huggingface/transformers";

// --- Network isolation -------------------------------------------------------
// The ONNX runtime is bundled inside the extension. Nothing is fetched from a CDN,
// and model files may only be fetched while the user explicitly downloads a model.
env.allowLocalModels = false;
env.allowRemoteModels = false;
env.useBrowserCache = true;
env.useWasmCache = false;
// The WASM glue is bundled (see src/vendor/ort-patches.js); only the binary is a file.
// One thread: worker threads would need cross-origin isolation and a separate script.
env.backends.onnx.wasm.wasmPaths = {
  wasm: browser.runtime.getURL("vendor/ort-wasm-simd-threaded.asyncify.wasm"),
};
env.backends.onnx.wasm.numThreads = 1;

const loaded = { text: null, vision: null }; // { id, tokenizer|processor, model }
export const progress = { text: null, vision: null };
let device = "webgpu";

export async function detectDevice() {
  try {
    if (!(navigator.gpu && (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })))) {
      throw new Error("no adapter");
    }
    device = "webgpu";
  } catch {
    device = "wasm";
  }
  return device;
}

export function loadedModels() {
  return { text: loaded.text?.id ?? null, vision: loaded.vision?.id ?? null };
}

function progressTracker(kind, onProgress) {
  const files = new Map();
  return (p) => {
    if (p.status !== "progress" || !p.total) return;
    files.set(p.file, { loaded: p.loaded, total: p.total });
    let loadedBytes = 0, totalBytes = 0;
    for (const f of files.values()) { loadedBytes += f.loaded; totalBytes += f.total; }
    progress[kind] = { loaded: loadedBytes, total: totalBytes };
    onProgress?.(progress[kind]);
  };
}

export async function unload(kind) {
  const m = loaded[kind];
  loaded[kind] = null;
  if (m) await m.model.dispose?.();
}

// `spec` comes from CATALOG.browser. Set allowDownload only for an explicit user download.
export async function load(kind, spec, { allowDownload = false, onProgress } = {}) {
  if (loaded[kind]?.id === spec.id) return loaded[kind];
  await unload(kind);
  progress[kind] = { loaded: 0, total: 0 };
  const opts = { dtype: spec.dtype, device, progress_callback: progressTracker(kind, onProgress) };
  env.allowRemoteModels = allowDownload;
  try {
    if (kind === "vision") {
      const processor = await AutoProcessor.from_pretrained(spec.id, opts);
      const model = await AutoModelForImageTextToText.from_pretrained(spec.id, opts);
      loaded.vision = { id: spec.id, processor, model };
    } else {
      const tokenizer = await AutoTokenizer.from_pretrained(spec.id, opts);
      const model = await AutoModelForCausalLM.from_pretrained(spec.id, opts);
      loaded.text = { id: spec.id, tokenizer, model };
    }
    return loaded[kind];
  } finally {
    env.allowRemoteModels = false;
    progress[kind] = null;
  }
}

export async function forget(kind, spec) {
  if (loaded[kind]?.id === spec.id) await unload(kind);
  const cache = await caches.open(env.cacheKey);
  for (const req of await cache.keys()) {
    if (req.url.includes(`/${spec.id}/`)) await cache.delete(req);
  }
}

// Runs generation, calling onPartial with the text so far. Returns the full text.
// `signal` aborts generation at the next token.
async function generate(model, tokenizer, inputs, maxNewTokens, onPartial, signal) {
  const stop = new InterruptableStoppingCriteria();
  const abort = () => stop.interrupt();
  signal?.addEventListener("abort", abort);
  let text = "";
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (piece) => {
      text += piece;
      onPartial(text);
    },
  });
  try {
    await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false,
      streamer,
      stopping_criteria: [stop],
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  return text;
}

export async function chatText(spec, messages, { onPartial, signal }) {
  const { tokenizer, model } = await load("text", spec);
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true,
    enable_thinking: false,
  });
  const promptTokens = inputs.input_ids.dims.at(-1);
  return generate(model, tokenizer, inputs, Math.min(2048, promptTokens * 2 + 64), onPartial, signal);
}

export async function readImage(spec, imageBlob, prompt, { onPartial, signal }) {
  const { processor, model } = await load("vision", spec);
  const image = await RawImage.fromBlob(imageBlob);
  const conversation = [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const text = processor.apply_chat_template(conversation, { add_generation_prompt: true });
  const inputs = await processor(text, image);
  return generate(model, processor.tokenizer, inputs, 1024, onPartial, signal);
}
