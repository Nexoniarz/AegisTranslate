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

  // Styles are handed over by the background page and adopted into a closed
  // shadow root, so no extension file is ever exposed to the page.
  const sheet = browser.runtime.sendMessage({ type: "overlayCss" }).then((css) => {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  });

  function ensureRoot() {
    if (root) return;
    host = document.createElement("aegis-translate");
    host.style.cssText = "all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647;";
    root = host.attachShadow({ mode: "closed" });
    sheet.then((s) => { if (root) root.adoptedStyleSheets = [s]; });
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
    const card = el("section", "nv-card nv-card--floating aegis-card");
    card.setAttribute("aria-label", title);
    const head = el("header", "nv-card__header");
    const heading = el("div", "aegis-heading");
    heading.append(el("span", "nv-overline nv-text-secondary", title));
    const badge = el("span", "nv-badge nv-badge--accent");
    badge.append(el("span", "nv-badge__dot"), el("span", null, "On-device"));
    heading.append(badge);
    const close = el("button", "nv-button nv-button--ghost nv-button--icon nv-button--sm", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => card.remove());
    head.append(heading, close);
    const body = el("div", "nv-card__body aegis-body");
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-busy", "true");
    for (let i = 0; i < 3; i++) body.append(el("div", "nv-skeleton nv-skeleton--text"));
    card.append(head, body);

    const r = pageRect(anchorRect);
    card.style.top = `${r.bottom + 8}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, scrollX + innerWidth - 392))}px`;
    root.append(card);
    return body;
  }

  function done(body, ...children) {
    body.removeAttribute("aria-busy");
    body.replaceChildren(...children);
  }

  function showError(body, error) {
    done(body, el("p", "nv-body nv-text-danger", error));
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
    done(body, el("p", "nv-body aegis-translation", res.translation));
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
    if (!res.lines.length) return done(body, el("p", "nv-body nv-text-secondary", "No text found in this image."));
    const list = el("ol", "aegis-lines");
    for (const { original, translation } of res.lines) {
      const li = el("li");
      if (settings.showOriginal && original) li.append(el("div", "nv-caption nv-text-secondary", original));
      li.append(el("div", "nv-body aegis-translation", translation));
      list.append(li);
    }
    done(body, list);
  }

  // --- Hover chip ------------------------------------------------------------
  function placeChip(img) {
    ensureRoot();
    if (!chip) {
      chip = el("button", "nv-button nv-button--primary nv-button--sm nv-button--pill aegis-chip", "Translate");
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (chipTarget) runImage(chipTarget);
      });
      root.append(chip);
    }
    chipTarget = img;
    const r = pageRect(img.getBoundingClientRect());
    chip.hidden = false;
    chip.style.top = `${r.top + 8}px`;
    chip.style.left = `${r.left + r.width - (chip.offsetWidth || 96) - 8}px`;
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
