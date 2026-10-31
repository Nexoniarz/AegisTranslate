// Client for the local helper (helper/aegistranslate_helper.py), a native-messaging
// host that runs llama.cpp on the best GPU. Firefox starts the helper on connect
// and stops it on disconnect; we disconnect after a few idle minutes.

const HOST = "aegistranslate_helper";

let port = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, onEvent }
let idleTimer = null;

export const state = {
  status: "idle", // idle | connecting | ready | missing | error
  info: null, // last hello/load result: { device, devices, llama_server, loaded, version }
  error: null,
  progress: { text: null, vision: null }, // { text, loaded?, total? } while a model starts or downloads
};

let onChange = () => {};
export function onStateChange(fn) {
  onChange = fn;
}

export async function hasPermission() {
  return browser.permissions.contains({ permissions: ["nativeMessaging"] });
}

function friendlyError(message) {
  if (/No such native application|not found|does not exist/i.test(message ?? "")) {
    return "The local helper is not installed. See the README, section “Local helper”.";
  }
  return message || "The local helper stopped unexpectedly.";
}

function connect() {
  if (port) return port;
  port = browser.runtime.connectNative(HOST);
  state.status = "connecting";
  state.error = null;
  port.onMessage.addListener((msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "result") {
      pending.delete(msg.id);
      entry.resolve(msg);
    } else if (msg.type === "error") {
      pending.delete(msg.id);
      entry.reject(new Error(msg.error));
    } else {
      entry.onEvent?.(msg);
    }
  });
  port.onDisconnect.addListener((p) => {
    const error = p.error?.message;
    port = null;
    state.info = null;
    state.status = error ? (/No such native application/i.test(error) ? "missing" : "error") : "idle";
    state.error = error ? friendlyError(error) : null;
    for (const entry of pending.values()) entry.reject(new Error(friendlyError(error)));
    pending.clear();
    onChange();
  });
  return port;
}

export function disconnect() {
  clearTimeout(idleTimer);
  if (port) {
    port.disconnect();
    port = null;
  }
  state.status = "idle";
  state.info = null;
  state.progress = { text: null, vision: null };
  for (const entry of pending.values()) entry.reject(new Error("The local helper was stopped."));
  pending.clear();
  onChange();
}

// Stop the helper (and free its VRAM) after `minutes` without a request.
export function scheduleIdleStop(minutes) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size === 0) disconnect();
  }, minutes * 60_000);
}

export function cancel(id) {
  if (port && pending.has(id)) port.postMessage({ type: "cancel", target: id });
}

// Sends one request. Returns { id, done } where done resolves with the result message.
export function request(msg, onEvent) {
  clearTimeout(idleTimer);
  const id = nextId++;
  const done = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onEvent });
    try {
      connect().postMessage({ ...msg, id });
    } catch (e) {
      pending.delete(id);
      reject(new Error(friendlyError(e.message)));
    }
  });
  done.then(
    (result) => {
      if (result.device !== undefined) state.info = result;
      state.status = "ready";
      onChange();
    },
    () => {}
  );
  return { id, done };
}

export async function hello() {
  return request({ type: "hello" }).done;
}

export async function load(kind, spec) {
  state.progress[kind] = { text: "Starting…" };
  onChange();
  try {
    return await request({ type: "load", kind, model: spec.hf }, (event) => {
      if (event.type === "status") {
        state.progress[kind] = { text: event.text, loaded: event.loaded, total: event.total };
        onChange();
      }
    }).done;
  } finally {
    state.progress[kind] = null;
    onChange();
  }
}

export async function unload(kind) {
  if (port) await request({ type: "unload", kind }).done;
}

async function chat(kind, spec, payload, { onPartial, onStatus, signal }) {
  let text = "";
  const { id, done } = request({ type: "chat", kind, model: spec.hf, payload }, (event) => {
    if (event.type === "token") {
      text += event.text;
      onPartial(text);
    } else if (event.type === "status") {
      state.progress[kind] = { text: event.text, loaded: event.loaded, total: event.total };
      onStatus?.(event.text);
      onChange();
    }
  });
  const abort = () => cancel(id);
  signal?.addEventListener("abort", abort);
  try {
    return (await done).text;
  } finally {
    signal?.removeEventListener("abort", abort);
    state.progress[kind] = null;
  }
}

export function chatText(spec, messages, opts) {
  return chat(
    "text",
    spec,
    { messages, temperature: 0, max_tokens: 2048, chat_template_kwargs: { enable_thinking: false } },
    opts
  );
}

export async function readImage(spec, imageBlob, prompt, opts) {
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(imageBlob);
  });
  const content = [
    { type: "image_url", image_url: { url } },
    { type: "text", text: prompt },
  ];
  return chat("vision", spec, { messages: [{ role: "user", content }], temperature: 0, max_tokens: 1024 }, opts);
}
