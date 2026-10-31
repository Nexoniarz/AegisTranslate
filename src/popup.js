import { CATALOG, LANGUAGES, IDLE_CHOICES, DEFAULT_SETTINGS, selectedModel } from "./models.js";

const $ = (id) => document.getElementById(id);
const TONES = ["nv-badge--success", "nv-badge--accent", "nv-badge--warning", "nv-badge--danger"];
const KINDS = ["text", "vision"];
const ENGINE_HINTS = {
  browser: "Runs inside Firefox on the GPU Firefox uses. Nothing to install.",
  helper: "Runs llama.cpp on your most powerful GPU through a small helper that Firefox starts and stops by itself.",
};

let current = null; // last status from the background page

function fill(select, entries) {
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
}

fill($("targetLang"), LANGUAGES.map((l) => [l, l]));
fill($("helperIdleMinutes"), IDLE_CHOICES.map(([m, label]) => [String(m), label]));
$("version").textContent = `v${browser.runtime.getManifest().version}`;

const send = (msg) => browser.runtime.sendMessage(msg);

function showError(text) {
  $("error").hidden = !text;
  $("error").textContent = text ?? "";
}

function setBadge(el, text, tone) {
  el.classList.remove(...TONES);
  if (tone) el.classList.add(`nv-badge--${tone}`);
  const label = el.querySelector("span:last-child") ?? el;
  label.textContent = text;
}

function gb(bytes) {
  return (bytes / 1e9).toFixed(2);
}

function render(status) {
  current = status;
  const s = status.settings;
  const engine = s.engine;
  for (const key of ["enabled", "visionEnabled", "hoverChip", "showOriginal"]) $(key).checked = s[key];
  $("translatePage").disabled = !s.enabled;
  $("targetLang").value = s.targetLang;
  $("helperIdleMinutes").value = String(s.helperIdleMinutes);
  $("visionBox").hidden = !s.visionEnabled;
  $("visionOff").hidden = s.visionEnabled;
  $("visionState").hidden = !s.visionEnabled;
  setBadge($("statePill"), s.enabled ? "On" : "Off", s.enabled ? "success" : null);

  for (const button of document.querySelectorAll("[data-engine]")) {
    button.setAttribute("aria-pressed", String(button.dataset.engine === engine));
  }
  $("engineHint").textContent = ENGINE_HINTS[engine];
  $("helperBox").hidden = engine !== "helper";
  renderHelper(status.helper);

  if (engine === "browser") {
    $("deviceLine").textContent =
      status.browser.device === "wasm" ? "No WebGPU: running on the CPU (slow)" : "WebGPU ready";
    $("deviceLine").classList.toggle("nv-text-warning", status.browser.device === "wasm");
  } else {
    const device = status.helper.info?.device;
    $("deviceLine").textContent = device ? device.description : "Local helper";
    $("deviceLine").classList.remove("nv-text-warning");
  }

  for (const kind of KINDS) {
    fill($(`${kind}Model`), Object.entries(CATALOG[engine][kind]).map(([k, m]) => [k, m.label]));
    $(`${kind}Model`).value = s.models[engine][kind];
    if (engine === "browser") renderBrowserModel(kind, status);
    else renderHelperModel(kind, status);
  }
}

function renderHelper(h) {
  const states = {
    ready: ["Running", "success"],
    connecting: ["Starting", "accent"],
    idle: ["Stopped", null],
    missing: ["Not installed", "warning"],
    error: ["Error", "danger"],
  };
  const [label, tone] = h.permission ? states[h.status] : ["Needs permission", "warning"];
  setBadge($("helperState"), label, tone);
  // The GPU name is shown in the header; this caption only pushes the buttons to the end.
  $("helperDevice").textContent = h.info?.llama_server ? "" : h.status === "ready" ? "llama-server not found" : "";
  $("helperError").hidden = !h.error;
  $("helperError").textContent = h.error ?? "";
  $("helperSetup").hidden = h.status !== "missing";
  $("helperStop").hidden = h.status !== "ready";
  $("helperCheck").textContent = h.permission ? "Check" : "Allow";
}

function renderBrowserModel(kind, status) {
  const s = status.settings;
  const spec = selectedModel(s, kind, "browser");
  const downloaded = !!s.downloaded[spec.id];
  const inMemory = status.browser.loaded[kind] === spec.id;
  const p = status.browser.progress[kind];

  if (p) setBadge($(`${kind}State`), downloaded ? "Loading" : "Downloading", "accent");
  else if (inMemory) setBadge($(`${kind}State`), "On GPU", "success");
  else setBadge($(`${kind}State`), downloaded ? "Downloaded" : "Not downloaded", null);

  const button = $(`${kind}Load`);
  button.textContent = downloaded ? "Load" : "Download";
  button.hidden = inMemory && !p;
  button.disabled = !!p;
  button.setAttribute("aria-busy", String(!!p));
  $(`${kind}Forget`).hidden = !downloaded || !!p;
  $(`${kind}Detail`).textContent = spec.id.split("/").pop();
  renderProgress(kind, p);
}

function renderHelperModel(kind, status) {
  const spec = selectedModel(status.settings, kind, "helper");
  const h = status.helper;
  const loading = h.progress[kind];
  const inMemory = h.info?.loaded?.[kind] === spec.hf;

  if (loading) setBadge($(`${kind}State`), loading.total ? "Downloading" : "Loading", "accent");
  else if (inMemory) setBadge($(`${kind}State`), "On GPU", "success");
  else setBadge($(`${kind}State`), "Not loaded", null);

  const button = $(`${kind}Load`);
  button.textContent = "Load";
  button.hidden = inMemory && !loading;
  button.disabled = !!loading || !h.permission;
  button.setAttribute("aria-busy", String(!!loading));
  $(`${kind}Forget`).hidden = true;
  $(`${kind}Detail`).textContent = loading?.text ?? (inMemory ? spec.hf.split("/").pop() : "Downloaded on first load");
  const bar = $(`${kind}Progress`);
  bar.hidden = !loading?.total;
  if (loading?.total) bar.style.setProperty("--progress", loading.loaded / loading.total);
}

function renderProgress(kind, p) {
  const bar = $(`${kind}Progress`);
  bar.hidden = !p;
  if (!p) return;
  bar.style.setProperty("--progress", p.total ? p.loaded / p.total : 0);
  if (p.total) $(`${kind}Detail`).textContent = `${gb(p.loaded)} of ${gb(p.total)} GB`;
}

async function refresh() {
  const status = await send({ type: "status" });
  if (status?.settings) render(status);
}

async function setModel(kind, key) {
  const { models = DEFAULT_SETTINGS.models } = await browser.storage.local.get("models");
  const engine = current.settings.engine;
  await browser.storage.local.set({
    models: { ...DEFAULT_SETTINGS.models, ...models, [engine]: { ...DEFAULT_SETTINGS.models[engine], ...models[engine], [kind]: key } },
  });
}

// --- Events ---------------------------------------------------------------------
for (const key of ["enabled", "visionEnabled", "hoverChip", "showOriginal"]) {
  $(key).addEventListener("change", async () => {
    await browser.storage.local.set({ [key]: $(key).checked });
    refresh();
  });
}
$("targetLang").addEventListener("change", async () => {
  await browser.storage.local.set({ targetLang: $("targetLang").value });
  refresh();
});
$("helperIdleMinutes").addEventListener("change", async () => {
  await browser.storage.local.set({ helperIdleMinutes: Number($("helperIdleMinutes").value) });
  refresh();
});
for (const kind of KINDS) {
  $(`${kind}Model`).addEventListener("change", async () => {
    await setModel(kind, $(`${kind}Model`).value);
    refresh();
  });
}

// Talking to a native app needs an optional permission, asked for on first use.
// permissions.request must be the first await in the click handler.
async function ensureHelperPermission() {
  const granted = await browser.permissions.request({ permissions: ["nativeMessaging"] });
  if (!granted) showError("Without this permission AegisTranslate cannot start the local helper.");
  return granted;
}

for (const button of document.querySelectorAll("[data-engine]")) {
  button.addEventListener("click", async () => {
    showError(null);
    const engine = button.dataset.engine;
    if (engine === "helper" && !(await ensureHelperPermission())) return;
    await browser.storage.local.set({ engine });
    await refresh();
    if (engine === "helper") checkHelper();
  });
}

async function checkHelper() {
  const res = await send({ type: "helperCheck" });
  if (res?.settings) render(res);
}

$("helperCheck").addEventListener("click", async () => {
  showError(null);
  if (!current.helper.permission && !(await ensureHelperPermission())) return;
  await checkHelper();
});
$("translatePage").addEventListener("click", async () => {
  showError(null);
  if (!current?.settings.enabled) return showError("Turn AegisTranslate on first.");
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.sendMessage(tab.id, { type: "togglePage" });
    window.close();
  } catch {
    showError("This page can't be translated (Firefox pages and add-on stores are off limits to add-ons).");
  }
});
$("helperStop").addEventListener("click", async () => {
  const res = await send({ type: "helperStop" });
  if (res?.settings) render(res);
});

for (const kind of KINDS) {
  $(`${kind}Load`).addEventListener("click", async () => {
    showError(null);
    const pending = send({ type: "load", kind });
    setTimeout(refresh, 100);
    const res = await pending;
    if (!res?.ok) showError(res?.error ?? "Loading failed.");
    if (res?.settings) render(res);
  });
  $(`${kind}Forget`).addEventListener("click", async () => {
    const res = await send({ type: "forget", kind });
    if (!res?.ok) showError(res?.error);
    if (res?.settings) render(res);
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress" && current?.settings.engine === "browser") {
    renderProgress(msg.kind, msg);
  } else if (msg.type === "changed") {
    refresh();
  }
});

// First run: store defaults so the content script sees the same values.
browser.storage.local.get(null).then(async (stored) => {
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !(k in stored)));
  if (Object.keys(missing).length) await browser.storage.local.set(missing);
  refresh();
});
