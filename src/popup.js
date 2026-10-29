import { TEXT_MODELS, VISION_MODELS, LANGUAGES, DEFAULT_SETTINGS } from "./models.js";

const $ = (id) => document.getElementById(id);
const CATALOG = { text: TEXT_MODELS, vision: VISION_MODELS };

function fillSelect(select, entries) {
  for (const [value, label] of entries) select.append(new Option(label, value));
}

fillSelect($("targetLang"), LANGUAGES.map((l) => [l, l]));
fillSelect($("textModel"), Object.entries(TEXT_MODELS).map(([k, m]) => [k, m.label]));
fillSelect($("visionModel"), Object.entries(VISION_MODELS).map(([k, m]) => [k, m.label]));

const send = (msg) => browser.runtime.sendMessage(msg);

function showError(text) {
  $("error").hidden = !text;
  $("error").textContent = text ?? "";
}

function render(status) {
  const s = status.settings;
  for (const key of ["enabled", "visionEnabled", "hoverChip", "showOriginal"]) $(key).checked = s[key];
  for (const key of ["targetLang", "textModel", "visionModel"]) $(key).value = s[key];
  $("visionBox").hidden = !s.visionEnabled;
  $("gpu").textContent = `GPU: ${status.gpuInfo}`;
  $("gpu").classList.toggle("warn", status.device !== "webgpu");

  for (const kind of ["text", "vision"]) {
    const key = s[kind === "text" ? "textModel" : "visionModel"];
    const spec = CATALOG[kind][key];
    const downloaded = !!s.downloaded[spec.id];
    const inMemory = status.loaded[kind] === key;
    $(`${kind}State`).textContent = inMemory ? "Loaded on GPU" : downloaded ? "Downloaded" : "Not downloaded";
    $(`${kind}Download`).textContent = downloaded ? "Load" : "Download";
    $(`${kind}Download`).hidden = inMemory;
    $(`${kind}Forget`).hidden = !downloaded;
    renderProgress(kind, status.progress[kind]);
  }
}

function renderProgress(kind, p) {
  const bar = $(`${kind}Progress`);
  bar.hidden = !p;
  if (p) { bar.max = p.total; bar.value = p.loaded; }
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
    $(`${kind}Download`).disabled = true;
    $(`${kind}State`).textContent = "Downloading…";
    const res = await send({ type: "download", kind });
    $(`${kind}Download`).disabled = false;
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
