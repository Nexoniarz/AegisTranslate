import { TEXT_MODELS, VISION_MODELS, LANGUAGES, DEFAULT_SETTINGS } from "./models.js";

const $ = (id) => document.getElementById(id);
const CATALOG = { text: TEXT_MODELS, vision: VISION_MODELS };
const TONES = ["nv-badge--success", "nv-badge--accent", "nv-badge--warning", "nv-badge--danger"];

function fillSelect(select, entries) {
  for (const [value, label] of entries) select.append(new Option(label, value));
}

fillSelect($("targetLang"), LANGUAGES.map((l) => [l, l]));
fillSelect($("textModel"), Object.entries(TEXT_MODELS).map(([k, m]) => [k, m.label]));
fillSelect($("visionModel"), Object.entries(VISION_MODELS).map(([k, m]) => [k, m.label]));
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

function render(status) {
  const s = status.settings;
  for (const key of ["enabled", "visionEnabled", "hoverChip", "showOriginal"]) $(key).checked = s[key];
  for (const key of ["targetLang", "textModel", "visionModel"]) $(key).value = s[key];
  $("visionBox").hidden = !s.visionEnabled;
  $("visionState").hidden = !s.visionEnabled;
  $("visionOff").hidden = s.visionEnabled;

  setBadge($("statePill"), s.enabled ? "On" : "Off", s.enabled ? "success" : null);
  $("gpu").textContent = status.device === "webgpu" ? status.gpuInfo : "No WebGPU: CPU fallback (slow)";
  $("gpu").classList.toggle("nv-text-warning", status.device !== "webgpu");

  for (const kind of ["text", "vision"]) {
    const key = s[kind === "text" ? "textModel" : "visionModel"];
    const spec = CATALOG[kind][key];
    const downloaded = !!s.downloaded[spec.id];
    const inMemory = status.loaded[kind] === key;
    const busy = !!status.progress[kind];

    if (busy) setBadge($(`${kind}State`), downloaded ? "Loading" : "Downloading", "accent");
    else if (inMemory) setBadge($(`${kind}State`), "On GPU", "success");
    else if (downloaded) setBadge($(`${kind}State`), "Downloaded", null);
    else setBadge($(`${kind}State`), "Not downloaded", null);

    const button = $(`${kind}Download`);
    button.textContent = downloaded ? "Load" : "Download";
    button.hidden = inMemory && !busy;
    button.setAttribute("aria-busy", String(busy));
    button.disabled = busy;
    $(`${kind}Forget`).hidden = !downloaded || busy;
    $(`${kind}Detail`).textContent = spec.id.split("/").pop();
    renderProgress(kind, status.progress[kind]);
  }
}

function renderProgress(kind, p) {
  const bar = $(`${kind}Progress`);
  bar.hidden = !p;
  if (!p) return;
  bar.style.setProperty("--progress", p.total ? p.loaded / p.total : 0);
  $(`${kind}Detail`).textContent = `${(p.loaded / 1e9).toFixed(2)} of ${(p.total / 1e9).toFixed(2)} GB`;
}

async function refresh() {
  const status = await send({ type: "status" });
  if (status?.ok) render(status);
}

for (const key of ["enabled", "visionEnabled", "hoverChip", "showOriginal"]) {
  $(key).addEventListener("change", async () => {
    await browser.storage.local.set({ [key]: $(key).checked });
    refresh();
  });
}
for (const key of ["targetLang", "textModel", "visionModel"]) {
  $(key).addEventListener("change", async () => {
    await browser.storage.local.set({ [key]: $(key).value });
    refresh();
  });
}

for (const kind of ["text", "vision"]) {
  $(`${kind}Download`).addEventListener("click", async () => {
    showError(null);
    const pending = send({ type: "download", kind });
    refresh();
    const res = await pending;
    if (!res?.ok) showError(res?.error ?? "Download failed.");
    refresh();
  });
  $(`${kind}Forget`).addEventListener("click", async () => {
    const res = await send({ type: "forget", kind });
    if (!res?.ok) showError(res?.error);
    refresh();
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") renderProgress(msg.kind, msg);
});

// First run: store defaults so the content script sees the same values.
browser.storage.local.get(null).then(async (stored) => {
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([k]) => !(k in stored)));
  if (Object.keys(missing).length) await browser.storage.local.set(missing);
  refresh();
});
