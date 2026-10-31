// Background page: routes translation requests to the chosen engine and streams
// the results to the page that asked.
import { DEFAULT_SETTINGS, selectedModel } from "./models.js";
import { translationMessages, READ_IMAGE_PROMPT, NO_TEXT, cleanOutput, loopCut } from "./prompts.js";
import * as browserEngine from "./browser-engine.js";
import * as helper from "./helper-client.js";

const ENGINES = { browser: browserEngine, helper };
let queue = Promise.resolve();

// Model loads and inference share one GPU, so run them one at a time.
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function getSettings() {
  const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    models: {
      browser: { ...DEFAULT_SETTINGS.models.browser, ...stored.models?.browser },
      helper: { ...DEFAULT_SETTINGS.models.helper, ...stored.models?.helper },
    },
  };
}

function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => {}); // the popup may be closed
}

helper.onStateChange(() => broadcast({ type: "changed" }));

// --- Model management ----------------------------------------------------------
async function ensureLoaded(settings, kind, { allowDownload = false } = {}) {
  const spec = selectedModel(settings, kind);
  if (!spec) throw new Error(`No ${kind} model selected.`);
  if (settings.engine === "helper") {
    if (!(await helper.hasPermission())) {
      throw new Error("Allow AegisTranslate to talk to the local helper: open the popup and choose Local helper.");
    }
    // A chat request loads the model by itself; only the popup's Load button preloads.
    if (allowDownload) await helper.load(kind, spec);
    return spec;
  }
  if (!settings.downloaded[spec.id] && !allowDownload) {
    throw new Error(`${spec.label} is not downloaded yet. Open the AegisTranslate popup to download it.`);
  }
  await browserEngine.load(kind, spec, {
    allowDownload,
    onProgress: (p) => broadcast({ type: "progress", kind, ...p }),
  });
  if (!settings.downloaded[spec.id]) {
    const downloaded = { ...(await getSettings()).downloaded, [spec.id]: true };
    await browser.storage.local.set({ downloaded });
  }
  return spec;
}

async function forget(kind) {
  const settings = await getSettings();
  const spec = selectedModel(settings, kind, "browser");
  await browserEngine.forget(kind, spec);
  const { [spec.id]: _, ...downloaded } = settings.downloaded;
  await browser.storage.local.set({ downloaded });
}

async function unloadAll() {
  await browserEngine.unload("text");
  await browserEngine.unload("vision");
  helper.disconnect();
}

function afterRequest(settings) {
  if (settings.engine === "helper") helper.scheduleIdleStop(settings.helperIdleMinutes);
}

// --- Images --------------------------------------------------------------------
// Reads the image the user clicked, scaled so its longer side is at most `maxSide`.
async function imageBlob({ dataUrl, src }, maxSide) {
  let blob;
  if (dataUrl) {
    blob = await (await fetch(dataUrl)).blob();
  } else {
    // The page's canvas was tainted (cross-origin), so re-read the image. The
    // browser cache usually serves it without a new network request.
    const res = await fetch(src, { credentials: "include", cache: "force-cache" });
    if (!res.ok) throw new Error(`Could not read the image (HTTP ${res.status}).`);
    blob = await res.blob();
  }
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.convertToBlob({ type: "image/png" });
}

// --- Translation jobs -------------------------------------------------------------
// Runs one generation, streaming cleaned text to `onText`. If the model gets stuck
// repeating itself, generation is stopped and the repeated tail is cut off.
async function guarded(run, signal, onText) {
  const inner = new AbortController();
  const abort = () => inner.abort();
  signal.addEventListener("abort", abort);
  let cut = -1;
  try {
    const raw = await run(inner.signal, (t) => {
      if (cut >= 0) return;
      const text = cleanOutput(t);
      cut = loopCut(text);
      if (cut >= 0) inner.abort();
      onText(cut >= 0 ? text.slice(0, cut).trim() : text);
    });
    const text = cleanOutput(raw);
    if (cut < 0) cut = loopCut(text);
    return cut >= 0 ? text.slice(0, cut).trim() : text;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// A content script opens a port, sends one job, and receives:
//   { stage: "source" | "translation", text }   streamed, text so far
//   { stage: "status", text }                    the model is starting or downloading
//   { stage: "done", text?, noText? } | { stage: "error", error }
// Jobs: { type: "text", text, markers? } (markers: a page block, see content.js)
//       { type: "image", dataUrl?, src }
async function runJob(job, post, signal) {
  const settings = await getSettings();
  if (!settings.enabled) throw new Error("AegisTranslate is turned off.");
  const engine = ENGINES[settings.engine];
  // Model start-up and download progress (local helper), shown in the card.
  const onStatus = (text) => post({ stage: "status", text });

  const translate = async (text) => {
    const spec = await ensureLoaded(settings, "text");
    const messages = translationMessages(text, settings.targetLang, { markers: !!job.markers });
    return guarded(
      (sig, onPartial) => engine.chatText(spec, messages, { signal: sig, onPartial, onStatus }),
      signal,
      (text) => post({ stage: "translation", text })
    );
  };

  try {
    let translation;
    if (job.type === "text") {
      translation = await serial(() => translate(job.text));
    } else if (job.type === "image") {
      if (!settings.visionEnabled) throw new Error("Image translation is turned off.");
      const blob = await imageBlob(job, settings.maxImageSide);
      const source = await serial(async () => {
        const spec = await ensureLoaded(settings, "vision");
        return guarded(
          (sig, onPartial) => engine.readImage(spec, blob, READ_IMAGE_PROMPT, { signal: sig, onPartial, onStatus }),
          signal,
          (text) => {
            if (!NO_TEXT.startsWith(text)) post({ stage: "source", text });
          }
        );
      });
      if (signal.aborted) return;
      if (!source || source.includes(NO_TEXT)) return post({ stage: "done", noText: true });
      post({ stage: "source", text: source });
      translation = await serial(() => translate(source));
    }
    if (signal.aborted) return;
    post({ stage: "done", text: translation });
  } finally {
    afterRequest(settings);
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "aegis-job") return;
  const controller = new AbortController();
  let open = true;
  const post = (msg) => open && port.postMessage(msg);
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort(); // the card was closed: stop generating
  });
  port.onMessage.addListener((job) => {
    runJob(job, post, controller.signal).catch((e) => post({ stage: "error", error: String(e?.message ?? e) }));
  });
});

// --- Popup ---------------------------------------------------------------------
let overlayCss = null;
function getOverlayCss() {
  overlayCss ??= Promise.all(
    ["niveus-shadow.css", "overlay.css"].map((f) => fetch(browser.runtime.getURL(f)).then((r) => r.text()))
  ).then((parts) => parts.join("\n"));
  return overlayCss;
}

let browserDevice = "checking";

async function status() {
  const settings = await getSettings();
  return {
    settings,
    browser: { device: browserDevice, loaded: browserEngine.loadedModels(), progress: browserEngine.progress },
    helper: {
      permission: await helper.hasPermission(),
      status: helper.state.status,
      info: helper.state.info,
      error: helper.state.error,
      progress: helper.state.progress,
    },
  };
}

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    switch (msg.type) {
      case "overlayCss":
        return getOverlayCss();
      case "status":
        return { ok: true, ...(await status()) };
      case "load": {
        const settings = await getSettings();
        await serial(() => ensureLoaded(settings, msg.kind, { allowDownload: true }));
        afterRequest(settings);
        return { ok: true, ...(await status()) };
      }
      case "forget":
        await serial(() => forget(msg.kind));
        return { ok: true, ...(await status()) };
      case "helperCheck":
        await helper.hello();
        helper.scheduleIdleStop((await getSettings()).helperIdleMinutes);
        return { ok: true, ...(await status()) };
      case "helperStop":
        helper.disconnect();
        return { ok: true, ...(await status()) };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), ...(await status()) };
  }
});

// Free GPU memory as soon as something is switched off or changed.
browser.storage.onChanged.addListener((changes) => {
  const { enabled, engine, visionEnabled, models } = changes;
  if ((enabled && !enabled.newValue) || engine) serial(unloadAll);
  if (visionEnabled && !visionEnabled.newValue) {
    serial(() => browserEngine.unload("vision"));
    serial(() => helper.unload("vision").catch(() => {}));
  }
  if (models) {
    for (const kind of ["text", "vision"]) {
      if (models.oldValue?.browser?.[kind] !== models.newValue?.browser?.[kind]) serial(() => browserEngine.unload(kind));
      if (models.oldValue?.helper?.[kind] !== models.newValue?.helper?.[kind]) {
        serial(() => helper.unload(kind).catch(() => {}));
      }
    }
  }
});

// --- Context menus & shortcuts -------------------------------------------------
browser.menus.create({ id: "aegis-text", title: "Translate selection", contexts: ["selection"] });
browser.menus.create({ id: "aegis-image", title: "Translate text in image", contexts: ["image"] });
browser.menus.create({ id: "aegis-page", title: "Translate page", contexts: ["page"] });

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "aegis-text") browser.tabs.sendMessage(tab.id, { type: "runSelection" });
  if (info.menuItemId === "aegis-image") browser.tabs.sendMessage(tab.id, { type: "runImage", src: info.srcUrl });
  if (info.menuItemId === "aegis-page") browser.tabs.sendMessage(tab.id, { type: "togglePage" });
});

const COMMANDS = { "translate-selection": "runSelection", "translate-page": "togglePage" };
browser.commands.onCommand.addListener(async (command) => {
  if (!COMMANDS[command]) return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) browser.tabs.sendMessage(tab.id, { type: COMMANDS[command] });
});

browserEngine.detectDevice().then((d) => {
  browserDevice = d;
  broadcast({ type: "changed" });
});
