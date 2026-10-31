// Content script: the Translate button on images, the result cards, and
// whole-page translation. All UI lives in a closed shadow root, and text is
// inserted with textContent or text-node data only, never as HTML.
import { marker } from "./prompts.js";

(() => {
  const MIN_IMAGE_SIZE = 120;
  let settings = { enabled: false, visionEnabled: false, hoverChip: true, showOriginal: true, targetLang: "English" };
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
    stopPage();
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
    const statusLine = el("p", "nv-caption nv-text-tertiary");
    placeholder.append(statusLine);
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
      if (msg.stage === "status") {
        statusLine.textContent = msg.text;
      } else if (msg.stage === "source" || msg.stage === "translation") {
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

  // --- Whole page ------------------------------------------------------------
  // Translates the page in place, one block (paragraph, heading, list item…) per
  // request: what is on screen first, the rest as it scrolls into view, and new
  // content as the page adds it. Original text is kept for "Show original".
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP", "VAR", "TEXTAREA",
    "INPUT", "SELECT", "OPTION", "SVG", "MATH", "CANVAS", "IFRAME", "AEGIS-TRANSLATE",
  ]);
  const MAX_UNIT_CHARS = 1500;
  const PARALLEL = 2; // the background runs one at a time; two keep it busy
  let page = null;

  const displayCache = new WeakMap();
  function isInline(e) {
    let d = displayCache.get(e);
    if (d === undefined) displayCache.set(e, (d = getComputedStyle(e).display));
    return d.startsWith("inline") || d === "contents";
  }

  function blockOf(node) {
    let e = node.parentElement;
    while (e && e !== document.body && isInline(e)) e = e.parentElement;
    return e ?? document.body;
  }

  function skippedElement(e) {
    return (
      SKIP_TAGS.has(e.tagName) ||
      e.isContentEditable ||
      e.getAttribute("translate") === "no" ||
      e.classList.contains("notranslate")
    );
  }

  // Finds new text under `root` and groups it into units of one block each.
  function scan(root) {
    for (let e = root.nodeType === 1 ? root : root.parentElement; e; e = e.parentElement) {
      if (skippedElement(e)) return;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === 1
          ? skippedElement(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
          : !page.known.has(n) && /\p{L}/u.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    const byBlock = new Map();
    if (root.nodeType === 3 && !page.known.has(root) && /\p{L}/u.test(root.data)) byBlock.set(blockOf(root), [root]);
    for (let n; (n = walker.nextNode()); ) {
      const block = blockOf(n);
      if (!byBlock.has(block)) byBlock.set(block, []);
      byBlock.get(block).push(n);
    }
    for (const [block, nodes] of byBlock) {
      let unit = null, size = 0;
      for (const n of nodes) {
        page.known.add(n);
        if (!unit || size + n.data.length > MAX_UNIT_CHARS) {
          unit = { nodes: [] };
          size = 0;
          if (!page.units.has(block)) page.units.set(block, []);
          page.units.get(block).push(unit);
        }
        unit.nodes.push(n);
        size += n.data.length;
      }
      page.observer.observe(block);
    }
  }

  function onVisible(entries) {
    page.starting = false;
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) {
        page.visible.delete(target);
        continue;
      }
      page.visible.add(target);
      for (const unit of page.units.get(target) ?? []) {
        if (!unit.queued) {
          unit.queued = true;
          unit.block = target;
          page.queue.push(unit);
        }
      }
    }
    pump();
  }

  function pump() {
    while (page && !page.error && page.running < PARALLEL && page.queue.length) {
      // Prefer blocks that are on screen right now.
      let i = page.queue.findIndex((u) => page.visible.has(u.block));
      if (i < 0) i = 0;
      const [unit] = page.queue.splice(i, 1);
      page.running++;
      translateUnit(unit).finally(() => {
        if (!page) return;
        page.running--;
        renderBar();
        pump();
      });
    }
    renderBar();
  }

  function translateUnit(unit) {
    const current = page;
    const parts = unit.nodes.map((n) => current.original.get(n) ?? n.data);
    unit.nodes.forEach((n, i) => current.original.set(n, parts[i]));
    const core = parts.map((t) => t.replace(/\s+/g, " ").trim());
    const markers = unit.nodes.length > 1;
    const text = markers ? core.map((t, i) => marker(i + 1) + t).join(" ") : core[0];
    return new Promise((resolve) => {
      const port = browser.runtime.connect({ name: "aegis-job" });
      current.ports.add(port);
      const end = () => {
        current.ports.delete(port);
        port.disconnect();
        resolve();
      };
      port.onMessage.addListener((msg) => {
        if (msg.stage === "done") {
          if (msg.text && page === current) apply(unit, parts, msg.text);
          current.done++;
          end();
        } else if (msg.stage === "error") {
          current.error = msg.error;
          end();
        }
      });
      port.onDisconnect.addListener(() => resolve());
      port.postMessage({ type: "text", text, markers });
    });
  }

  // Puts the translation into the unit's text nodes, keeping each node's
  // surrounding whitespace. With several nodes (a paragraph with a link, say),
  // the model's markers say which words go where; if it lost them, the whole
  // translation goes into the first node.
  function apply(unit, parts, translation) {
    const pad = (orig, t) => (t ? orig.match(/^\s*/)[0] + t + orig.match(/\s*$/)[0] : t);
    let texts;
    if (unit.nodes.length === 1) {
      texts = [translation.replace(/⟦\d+⟧/g, "").trim()];
    } else {
      const split = translation.split(/⟦(\d+)⟧/);
      const pieces = new Map();
      for (let i = 1; i < split.length; i += 2) {
        const k = Number(split[i]);
        pieces.set(k, ((pieces.get(k) ?? "") + " " + split[i + 1]).trim());
      }
      if (split[0].trim()) pieces.set(1, (split[0].trim() + " " + (pieces.get(1) ?? "")).trim());
      const ok = unit.nodes.every((_, i) => pieces.has(i + 1));
      texts = ok
        ? unit.nodes.map((_, i) => pieces.get(i + 1))
        : unit.nodes.map((_, i) => (i === 0 ? split.filter((_, j) => j % 2 === 0).join(" ").replace(/\s+/g, " ").trim() : ""));
    }
    unit.nodes.forEach((n, i) => {
      const t = pad(parts[i], texts[i]);
      page.translated.set(n, t);
      if (page.showing === "translation") n.data = t;
    });
  }

  function showPage(which) {
    page.showing = which;
    const source = which === "translation" ? page.translated : page.original;
    for (const [n, t] of source) n.data = t;
    renderBar();
  }

  function startPage() {
    if (!settings.enabled) return;
    page = {
      units: new Map(), // block element -> units
      known: new WeakSet(), // text nodes already in a unit
      original: new Map(), // text node -> original text
      translated: new Map(), // text node -> translated text
      queue: [],
      visible: new Set(),
      ports: new Set(),
      running: 0,
      done: 0,
      error: null,
      showing: "translation",
      starting: true, // until the first visibility check has queued what is on screen
      observer: new IntersectionObserver(onVisible, { rootMargin: "100% 0px" }),
    };
    let pending = [];
    let timer = null;
    page.mutations = new MutationObserver((records) => {
      for (const r of records) pending.push(...r.addedNodes);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const roots = pending.filter((n) => n.isConnected && n !== host);
        pending = [];
        if (page) roots.forEach(scan);
      }, 500);
    });
    page.mutations.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
    renderBar();
  }

  function stopPage() {
    if (!page) return;
    const p = page;
    page = null;
    p.observer.disconnect();
    p.mutations.disconnect();
    for (const port of p.ports) port.disconnect();
    for (const [n, t] of p.original) n.data = t;
    p.bar?.wrap.remove();
  }

  function togglePage() {
    if (!page) startPage();
    else showPage(page.showing === "translation" ? "original" : "translation");
  }

  function renderBar() {
    if (!page) return;
    if (!page.bar) {
      ensureRoot();
      const wrap = el("div", "nv-card nv-card--floating aegis-bar");
      wrap.setAttribute("role", "status");
      const badge = el("span", "nv-badge nv-badge--accent");
      badge.append(el("span", "nv-badge__dot"), el("span", null, "On-device"));
      const label = el("span", "nv-caption nv-text-secondary aegis-bar__label");
      const toggle = el("button", "nv-button nv-button--sm");
      toggle.addEventListener("click", togglePage);
      const close = el("button", "nv-button nv-button--ghost nv-button--icon nv-button--sm", "×");
      close.setAttribute("aria-label", "Stop and show the original page");
      close.title = "Stop and show the original page";
      close.addEventListener("click", stopPage);
      wrap.append(badge, label, toggle, close);
      root.append(wrap);
      page.bar = { wrap, label, toggle };
    }
    const { label, toggle } = page.bar;
    const busy = page.starting || page.running > 0 || page.queue.length > 0;
    label.classList.toggle("nv-text-danger", !!page.error);
    label.textContent = page.error
      ? page.error
      : busy
        ? `Translating into ${settings.targetLang}… ${page.done} done`
        : `Translated into ${settings.targetLang}`;
    toggle.textContent = page.showing === "translation" ? "Show original" : "Show translation";
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === "runSelection") runSelection();
    if (msg.type === "runImage") runImage(findImage(msg.src), msg.src);
    if (msg.type === "togglePage") togglePage();
  });
})();
