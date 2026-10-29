// Content script: the Translate button on images and the result cards.
// All UI lives in a closed shadow root, and text is inserted with textContent only.
(() => {
  const MIN_IMAGE_SIZE = 120;
  let settings = { enabled: false, visionEnabled: false, hoverChip: true, showOriginal: true };
  let host, root, chip, chipTarget = null;

  browser.storage.local.get(settings).then((s) => Object.assign(settings, s));
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, v] of Object.entries(changes)) if (k in settings) settings[k] = v.newValue;
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
    // `all: initial` shields the card from page styles; color-scheme must then be set again
    // so Niveus can follow the system appearance.
    host.style.cssText = "all: initial; color-scheme: light dark; position: absolute; top: 0; left: 0; z-index: 2147483647;";
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
  // Opens a card under `anchorRect`, starts `job` in the background page and
  // renders what streams back. Closing the card cancels the job.
  function openCard(anchorRect, title, job) {
    ensureRoot();
    const card = el("section", "nv-card nv-card--floating aegis-card");
    card.setAttribute("aria-label", title);

    const head = el("header", "nv-card__header");
    const heading = el("div", "aegis-heading");
    heading.append(el("span", "nv-overline nv-text-secondary", title));
    const badge = el("span", "nv-badge nv-badge--accent");
    badge.append(el("span", "nv-badge__dot"), el("span", null, "On-device"));
    const timer = el("span", "nv-caption nv-text-tertiary aegis-timer", "0 s");
    heading.append(badge, timer);
    const close = el("button", "nv-button nv-button--ghost nv-button--icon nv-button--sm", "×");
    close.setAttribute("aria-label", "Close");
    head.append(heading, close);

    const body = el("div", "nv-card__body aegis-body");
    body.setAttribute("aria-live", "polite");
    body.setAttribute("aria-busy", "true");
    const sections = {};
    const placeholder = el("div", "aegis-placeholder");
    for (let i = 0; i < 3; i++) placeholder.append(el("div", "nv-skeleton nv-skeleton--text"));
    body.append(placeholder);
    card.append(head, body);

    const r = pageRect(anchorRect);
    card.style.top = `${r.bottom + 8}px`;
    card.style.left = `${Math.max(8, Math.min(r.left, scrollX + innerWidth - 432))}px`;
    root.append(card);

    const started = performance.now();
    const tick = setInterval(() => {
      timer.textContent = `${Math.round((performance.now() - started) / 1000)} s`;
    }, 1000);

    const port = browser.runtime.connect({ name: "aegis-job" });
    const finish = () => {
      clearInterval(tick);
      body.removeAttribute("aria-busy");
      placeholder.remove();
      timer.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
      port.disconnect();
    };
    close.addEventListener("click", () => {
      finish();
      card.remove();
    });

    const section = (stage) => {
      if (sections[stage]) return sections[stage];
      const wrap = el("div", "aegis-section");
      if (stage === "source") {
        wrap.append(el("span", "nv-overline nv-text-tertiary", "Text in image"));
        wrap.hidden = !settings.showOriginal;
      } else if (job.type === "image") {
        wrap.append(el("span", "nv-overline nv-text-tertiary", "Translation"));
      }
      const text = el("p", stage === "source" ? "nv-body nv-text-secondary aegis-text" : "nv-body nv-text-primary aegis-text");
      wrap.append(text);
      // Source above translation, placeholder last while waiting.
      if (stage === "source" && sections.translation) body.insertBefore(wrap, sections.translation.wrap);
      else body.insertBefore(wrap, placeholder.isConnected ? placeholder : null);
      return (sections[stage] = { wrap, text });
    };

    port.onMessage.addListener((msg) => {
      if (msg.stage === "source" || msg.stage === "translation") {
        section(msg.stage).text.textContent = msg.text;
      } else if (msg.stage === "done") {
        if (msg.noText) body.append(el("p", "nv-body nv-text-secondary", "No text found in this image."));
        finish();
      } else if (msg.stage === "error") {
        body.append(el("p", "nv-body nv-text-danger", msg.error));
        finish();
      }
    });
    port.onDisconnect.addListener(() => clearInterval(tick));
    port.postMessage(job);
  }

  // --- Text ------------------------------------------------------------------
  function runSelection() {
    if (!settings.enabled) return;
    const sel = getSelection();
    const text = sel?.toString().trim();
    if (!text) return;
    openCard(sel.getRangeAt(0).getBoundingClientRect(), "Translation", { type: "text", text });
  }

  // --- Images ----------------------------------------------------------------
  function findImage(src) {
    return [...document.images].find((i) => i.currentSrc === src || i.src === src) ?? null;
  }

  // Use the pixels the page already has when the browser allows it; otherwise the
  // background page re-reads the image (normally straight from the HTTP cache).
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

  function runImage(img, src = img?.currentSrc || img?.src) {
    if (!settings.enabled || !src) return;
    const rect = img ? img.getBoundingClientRect() : new DOMRect(16, 16, 0, 0);
    openCard(rect, "Image", { type: "image", src, dataUrl: img ? grabPixels(img) : null });
  }

  // --- Translate button on images -------------------------------------------
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
