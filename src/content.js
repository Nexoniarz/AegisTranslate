// Content script: hover chip on images, result cards for images and selections.
// All UI lives in a closed shadow root and results are inserted with textContent only.
(() => {
  const MIN_IMAGE_SIZE = 120;
  let settings = { enabled: false, visionEnabled: false, hoverChip: true, showOriginal: true };
  let host, root, chip, chipTarget = null;

  browser.storage.local.get(settings).then((s) => Object.assign(settings, s));
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    if (!settings.enabled) teardown();
  });

  function ensureRoot() {
    if (root) return;
    host = document.createElement("aegis-translate");
    host.style.cssText = "all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647;";
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = browser.runtime.getURL("overlay.css");
    root.append(style);
    document.documentElement.append(host);
  }

  function teardown() {
    host?.remove();
    host = root = chip = chipTarget = null;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function pageRect(r) {
    return { top: r.top + scrollY, left: r.left + scrollX, width: r.width, height: r.height, bottom: r.bottom + scrollY };
  }

  // --- Result card -----------------------------------------------------------
  function openCard(anchorRect, title) {
    ensureRoot();
    const card = el("div", "card");
    const head = el("div", "head");
    head.append(el("span", "title", title));
    const close = el("button", "close", "×");
    close.title = "Close";
    close.addEventListener("click", () => card.remove());
    head.append(close);
    const body = el("div", "body");
    body.append(el("div", "status", "Translating locally…"));
    card.append(head, body);

    const r = pageRect(anchorRect);
    card.style.top = `${r.bottom + 6}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, scrollX + innerWidth - 380))}px`;
    root.append(card);
    return body;
  }

  function showError(body, error) {
    body.replaceChildren(el("div", "error", error));
  }

  // --- Text ------------------------------------------------------------------
  async function runSelection() {
    if (!settings.enabled) return;
    const sel = getSelection();
    const text = sel?.toString().trim();
    if (!text) return;
    const body = openCard(sel.getRangeAt(0).getBoundingClientRect(), "Translation");
    const res = await browser.runtime.sendMessage({ type: "translateText", text });
    if (!res?.ok) return showError(body, res?.error ?? "Translation failed.");
    body.replaceChildren(el("div", "translation", res.translation));
  }

  // --- Images ----------------------------------------------------------------
  function findImage(src) {
    return [...document.images].find((i) => i.currentSrc === src || i.src === src) ?? null;
  }

  // Use the pixels the page already has when the browser allows it; otherwise the
  // background script re-reads the image (normally straight from the HTTP cache).
  function grabPixels(img) {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  async function runImage(img, src = img?.currentSrc || img?.src) {
    if (!settings.enabled || !src) return;
    const rect = img ? img.getBoundingClientRect() : new DOMRect(16, 16, 0, 0);
    const body = openCard(rect, "Image text");
    const dataUrl = img ? grabPixels(img) : null;
    const res = await browser.runtime.sendMessage({ type: "translateImage", src, dataUrl });
    if (!res?.ok) return showError(body, res?.error ?? "Translation failed.");
    if (!res.lines.length) return body.replaceChildren(el("div", "status", "No text found in this image."));
    const list = el("ol", "lines");
    for (const { original, translation } of res.lines) {
      const li = el("li");
      if (settings.showOriginal && original) li.append(el("div", "original", original));
      li.append(el("div", "translation", translation));
      list.append(li);
    }
    body.replaceChildren(list);
  }

  // --- Hover chip ------------------------------------------------------------
  function placeChip(img) {
    ensureRoot();
    if (!chip) {
      chip = el("button", "chip", "Translate");
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (chipTarget) runImage(chipTarget);
      });
      root.append(chip);
    }
    chipTarget = img;
    const r = pageRect(img.getBoundingClientRect());
    chip.style.top = `${r.top + 8}px`;
    chip.style.left = `${r.left + r.width - 92}px`;
    chip.hidden = false;
  }

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!settings.enabled || !settings.visionEnabled || !settings.hoverChip) return;
      const t = e.target;
      if (t instanceof HTMLImageElement && t.width >= MIN_IMAGE_SIZE && t.height >= MIN_IMAGE_SIZE) placeChip(t);
      else if (chip && t !== host && t !== chipTarget) chip.hidden = true;
    },
    { passive: true }
  );

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "runSelection") runSelection();
    if (msg.type === "runImage") runImage(findImage(msg.src), msg.src);
  });
})();
