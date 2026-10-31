// End-to-end test: the built extension (dist/) in Chromium with a mocked
// WebExtension API, talking to the real native-messaging helper, which runs a
// fake llama-server. Exercises page → content script → background → helper →
// streamed tokens → result card.
//
//   npm run build && node test/e2e/run.cjs        (needs Playwright + Chromium)
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const ROOT = path.join(__dirname, "..", "..");
const DIST = path.join(ROOT, "dist");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html" };

// Minimal WebExtension API: one in-page event bus shared by background and content script.
function mockBrowser() {
  const event = () => {
    const listeners = [];
    return { addListener: (f) => listeners.push(f), removeListener() {}, listeners };
  };
  const fire = (ev, ...args) => ev.listeners.map((f) => f(...args));
  const store = {};
  const storageChanged = event();
  const onMessage = event();
  const onConnect = event();

  function portPair(name) {
    const make = () => ({ name, onMessage: event(), onDisconnect: event(), connected: true });
    const a = make(), b = make();
    for (const [self, other] of [[a, b], [b, a]]) {
      self.postMessage = (m) => {
        if (!self.connected) throw new Error("port closed");
        setTimeout(() => other.connected && fire(other.onMessage, structuredClone(m)), 0);
      };
      self.disconnect = () => {
        if (!self.connected) return;
        self.connected = other.connected = false;
        setTimeout(() => fire(other.onDisconnect, other), 0);
      };
    }
    return [a, b];
  }

  let nativePort = null;
  window.__nativeRecv = (msg) => nativePort && fire(nativePort.onMessage, msg);
  window.__nativeExit = () => {
    if (!nativePort) return;
    const p = nativePort;
    nativePort = null;
    fire(p.onDisconnect, p);
  };

  window.__fire = fire;
  window.browser = {
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return structuredClone(store);
          if (typeof keys === "string") return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
          return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? structuredClone(store[k]) : d]));
        },
        async set(values) {
          const changes = {};
          for (const [k, v] of Object.entries(values)) {
            changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
            store[k] = structuredClone(v);
          }
          fire(storageChanged, changes, "local");
        },
      },
      onChanged: storageChanged,
    },
    runtime: {
      getURL: (p) => `/ext/${p}`,
      getManifest: () => ({ version: "test" }),
      onMessage,
      async sendMessage(msg) {
        const results = fire(onMessage, structuredClone(msg)).filter((r) => r !== undefined);
        return results.length ? structuredClone(await results[0]) : undefined;
      },
      onConnect,
      connect({ name }) {
        const [mine, theirs] = portPair(name);
        setTimeout(() => fire(onConnect, theirs), 0);
        return mine;
      },
      connectNative(host) {
        if (host !== "aegistranslate_helper") throw new Error("No such native application " + host);
        const port = { name: host, onMessage: event(), onDisconnect: event(), error: null };
        port.postMessage = (m) => window.__nativeSend(JSON.stringify(m));
        port.disconnect = () => {
          nativePort = null;
          window.__nativeClose();
        };
        nativePort = port;
        window.__nativeOpen();
        return port;
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    menus: { create() {}, onClicked: event() },
    commands: { onCommand: event() },
    tabs: { query: async () => [], sendMessage: async () => {} },
  };

  // The card lives in a closed shadow root; open it up for the test.
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    return (window.__root = attach.call(this, { ...init, mode: "open" }));
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><body>
  <p id="para">Dzień dobry, świecie.</p>
  <article>
    <h1 id="title">Tytuł strony</h1>
    <p id="mixed">Witaj <a id="link" href="#">świecie</a> dziś.</p>
    <pre id="code">const x = 1;</pre>
    <p id="keep" translate="no">Nie tłumacz</p>
    <p id="far" style="margin-top: 6000px">Daleko w dole</p>
  </article>
  <canvas id="c" width="200" height="160"></canvas>
  <img id="img" width="200" height="160">
  <script>
    const c = document.getElementById("c"), g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 200, 160); g.fillStyle = "#000"; g.font = "24px sans-serif"; g.fillText("Hola", 20, 80);
    document.getElementById("img").src = c.toDataURL();
  </script>
</body>`;

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-e2e-"));
  const fakeLog = path.join(tmp, "calls.log");
  let helper = null;
  let helperExits = 0;
  let page;

  const browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e));

  // Native messaging bridge: one helper process per connectNative().
  await page.exposeFunction("__nativeOpen", () => {
    helper = spawn("python3", [path.join(ROOT, "helper", "aegistranslate_helper.py")], {
      env: {
        ...process.env,
        AEGIS_LLAMA_SERVER: path.join(ROOT, "test", "helper", "fake_llama_server.py"),
        XDG_CONFIG_HOME: tmp,
        FAKE_LOG: fakeLog,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = Buffer.alloc(0);
    helper.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const n = buf.readUInt32LE(0);
        const msg = JSON.parse(buf.subarray(4, 4 + n).toString());
        buf = buf.subarray(4 + n);
        page.evaluate((m) => window.__nativeRecv(m), msg).catch(() => {});
      }
    });
    const proc = helper;
    proc.on("exit", () => {
      helperExits++;
      if (helper === proc) {
        helper = null;
        page.evaluate(() => window.__nativeExit()).catch(() => {});
      }
    });
  });
  await page.exposeFunction("__nativeSend", (json) => {
    const data = Buffer.from(json);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(data.length);
    helper?.stdin.write(Buffer.concat([header, data]));
  });
  await page.exposeFunction("__nativeClose", () => {
    helper?.stdin.end();
  });

  await page.addInitScript(mockBrowser);
  await page.route("http://t/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/") return route.fulfill({ contentType: "text/html", body: PAGE });
    const file = path.join(DIST, p.replace(/^\/ext\//, ""));
    route.fulfill({ contentType: TYPES[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
  });

  await page.goto("http://t/");
  await page.evaluate(() =>
    browser.storage.local.set({ enabled: true, engine: "helper", visionEnabled: true, targetLang: "English", helperIdleMinutes: 5 })
  );
  await page.addScriptTag({ url: "/ext/background.js", type: "module" });
  await page.waitForTimeout(500);
  await page.addScriptTag({ url: "/ext/content.js" });
  await page.waitForTimeout(300);

  const cardText = () => page.evaluate(() => [...(window.__root?.querySelectorAll(".aegis-card") ?? [])].map((c) => c.innerText));
  const waitForCard = async (index, predicate, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const cards = await cardText();
      if (cards[index] && predicate(cards[index])) return cards[index];
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${label}; cards: ${JSON.stringify(await cardText())}`);
  };
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(["PASS", name]);
    } catch (e) {
      results.push(["FAIL", name, e.message]);
    }
  };

  await check("selected text is translated through the helper, streamed", async () => {
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("para"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.__fire(browser.runtime.onMessage, { type: "runSelection" });
    });
    const text = await waitForCard(0, (t) => /\d\.\d s/.test(t), "text card to finish");
    assert.match(text, /ECHO <source>\nDzień dobry, świecie\.\n<\/source> \/no_think/);
    assert.match(text, /kwargs=\{"enable_thinking": false\}/);
    const calls = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const args = calls[0];
    assert.equal(args[args.indexOf("--device") + 1], "CUDA0", "helper should pick the RTX card");
    assert.equal(args[args.indexOf("-hf") + 1], "Qwen/Qwen3-4B-GGUF:Q4_K_M");
  });

  await check("image: text is read by the vision model, then translated", async () => {
    await page.evaluate(() => window.__fire(browser.runtime.onMessage, { type: "runImage", src: document.getElementById("img").src }));
    const text = await waitForCard(1, (t) => /\d\.\d s/.test(t), "image card to finish");
    assert.match(text, /TEXT IN IMAGE\s*IMAGE image_url,text kwargs=null/i);
    assert.match(text, /TRANSLATION\s*ECHO <source>\nIMAGE image_url,text kwargs=null/i);
    const calls = fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(calls.some((a) => a[a.indexOf("-hf") + 1] === "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M"));
  });

  await check("closing a card cancels generation in llama-server", async () => {
    await page.evaluate(() => {
      document.getElementById("para").textContent = "SLOW " + "word ".repeat(60);
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("para"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.__fire(browser.runtime.onMessage, { type: "runSelection" });
    });
    await waitForCard(2, (t) => t.includes("ECHO"), "first streamed tokens");
    await page.evaluate(() => [...window.__root.querySelectorAll(".aegis-card")][2].querySelector("button").click());
    const deadline = Date.now() + 10_000;
    while (!fs.readFileSync(fakeLog, "utf8").includes('["cancelled"]') && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(fs.readFileSync(fakeLog, "utf8").includes('["cancelled"]'), "fake server never saw the stream closed");
  });

  await check("helper stops after the idle timeout and restarts on demand", async () => {
    await page.evaluate(() => browser.storage.local.set({ helperIdleMinutes: 0.02 }));
    await page.evaluate(() => {
      document.getElementById("para").textContent = "short";
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("para"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.__fire(browser.runtime.onMessage, { type: "runSelection" });
    });
    await waitForCard(2, (t) => t.includes("ECHO <source>\nshort"), "fourth card");
    const exitsBefore = helperExits;
    const deadline = Date.now() + 10_000;
    while (helperExits === exitsBefore && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(helperExits > exitsBefore, "helper did not exit after idle timeout");
    const status = await page.evaluate(() => browser.runtime.sendMessage({ type: "status" }));
    assert.equal(status.helper.status, "idle");
  });

  await check("popup status reports the helper's GPU", async () => {
    const status = await page.evaluate(() => browser.runtime.sendMessage({ type: "helperCheck" }));
    assert.equal(status.ok, true);
    assert.equal(status.helper.info.device.description, "NVIDIA GeForce RTX 3060 Ti");
  });

  const pageState = () =>
    page.evaluate(() => ({
      title: document.getElementById("title").textContent,
      mixed: document.getElementById("mixed").textContent,
      link: document.getElementById("link")?.textContent,
      linkIsLink: document.getElementById("link")?.tagName === "A",
      code: document.getElementById("code").textContent,
      keep: document.getElementById("keep").textContent,
      far: document.getElementById("far").textContent,
      dyn: document.getElementById("dyn")?.textContent,
      bar: window.__root?.querySelector(".aegis-bar")?.innerText ?? null,
    }));
  const waitPage = async (predicate, label) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const st = await pageState();
      if (predicate(st)) return st;
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${label}; page: ${JSON.stringify(await pageState())}`);
  };

  await check("whole page: visible blocks are translated in place", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.__fire(browser.runtime.onMessage, { type: "togglePage" }));
    const st = await waitPage((s) => /Translated into English/.test(s.bar ?? ""), "page translation to finish");
    assert.match(st.title, /^ECHO <source>\nTytuł strony\n<\/source>/);
    assert.match(st.mixed, /ECHO/);
    assert.equal(st.link, "świecie", "the link should keep its own words");
    assert.ok(st.linkIsLink, "the link element must survive");
    assert.equal(st.code, "const x = 1;", "code is not translated");
    assert.equal(st.keep, "Nie tłumacz", 'translate="no" is respected');
    assert.equal(st.far, "Daleko w dole", "off-screen text waits until it is scrolled to");
  });

  await check("whole page: text is translated when scrolled into view, and new content too", async () => {
    await page.evaluate(() => document.getElementById("far").scrollIntoView());
    await waitPage((s) => s.far.startsWith("ECHO"), "far paragraph");
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.id = "dyn";
      p.textContent = "Nowa treść";
      document.getElementById("far").after(p);
    });
    await waitPage((s) => s.dyn?.startsWith("ECHO"), "dynamically added paragraph");
  });

  await check("whole page: show original, show translation, and close restores", async () => {
    const click = (i) => page.evaluate((i) => window.__root.querySelectorAll(".aegis-bar button")[i].click(), i);
    await click(0);
    let st = await pageState();
    assert.equal(st.title, "Tytuł strony");
    assert.equal(st.mixed, "Witaj świecie dziś.");
    assert.match(st.bar, /Show translation/);
    await click(0);
    st = await pageState();
    assert.match(st.title, /^ECHO/);
    await click(1);
    st = await pageState();
    assert.equal(st.title, "Tytuł strony");
    assert.equal(st.far, "Daleko w dole");
    assert.equal(st.dyn, "Nowa treść");
    assert.equal(st.bar, null, "the bar is removed");
  });

  await check("turning translation off stops the helper", async () => {
    const exitsBefore = helperExits;
    await page.evaluate(() => browser.storage.local.set({ enabled: false }));
    const deadline = Date.now() + 10_000;
    while (helperExits === exitsBefore && Date.now() < deadline) await page.waitForTimeout(100);
    assert.ok(helperExits > exitsBefore);
  });

  await browser.close();
  helper?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const r of results) console.log(r.join("  "));
  process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
