#!/usr/bin/env python3
"""AegisTranslate local helper.

A Firefox native-messaging host. Firefox starts it when the extension needs it
and stops it when the extension disconnects (after a few idle minutes, when
translation is switched off, or when Firefox closes). It runs llama.cpp's
llama-server on the most capable GPU in the machine, bound to 127.0.0.1 on a
random port, and relays requests and streamed tokens between it and Firefox.

Only the Python standard library is used.
"""

import json
import os
import re
import shutil
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

VERSION = "0.2.0"
CONFIG_PATH = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "aegistranslate",
    "helper.json",
)
DEFAULT_CONFIG = {
    "llama_server": None,  # path to llama-server; None means $AEGIS_LLAMA_SERVER or $PATH
    "device": None,  # llama.cpp device name such as "CUDA0"; None picks the largest GPU
    "context": 4096,
    "extra_args": [],
}
DEVICE_LINE = re.compile(r"^\s*([A-Za-z][\w-]*\d+):\s*(.+?)\s*\((\d+) MiB,\s*(\d+) MiB free\)")


# --- Native messaging ---------------------------------------------------------

_out_lock = threading.Lock()


def send(message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    with _out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    body = sys.stdin.buffer.read(length)
    if len(body) < length:
        return None
    return json.loads(body.decode("utf-8"))


def log(*parts):
    # stderr ends up in the Browser Console, never in the message stream.
    print("[aegistranslate-helper]", *parts, file=sys.stderr, flush=True)


# --- Configuration and devices ------------------------------------------------


def load_config():
    config = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            config.update(json.load(f))
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        log("ignoring unreadable config:", e)
    return config


def find_llama_server(config):
    for candidate in (os.environ.get("AEGIS_LLAMA_SERVER"), config.get("llama_server")):
        if candidate and os.access(candidate, os.X_OK):
            return candidate
    return shutil.which("llama-server")


def list_devices(llama_server):
    try:
        out = subprocess.run(
            [llama_server, "--list-devices"], capture_output=True, text=True, timeout=60
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        log("could not list devices:", e)
        return []
    devices = []
    for line in (out.stdout + "\n" + out.stderr).splitlines():
        m = DEVICE_LINE.match(line)
        if m:
            devices.append(
                {"name": m.group(1), "description": m.group(2), "total_mib": int(m.group(3)), "free_mib": int(m.group(4))}
            )
    return devices


def pick_device(devices, configured):
    if configured:
        return next((d for d in devices if d["name"] == configured), {"name": configured, "description": configured})
    gpus = [d for d in devices if not d["name"].upper().startswith("CPU")]
    # The card with the most memory is the dedicated GPU on hybrid machines.
    return max(gpus, key=lambda d: d["total_mib"], default=None)


# --- llama-server processes ---------------------------------------------------


def _die_with_parent():
    """Linux: have the kernel stop llama-server if the helper itself is killed."""
    try:
        import ctypes

        ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG
    except Exception:
        pass


class _Spawner:
    """Starts child processes from one thread that lives as long as the helper.

    PR_SET_PDEATHSIG fires when the *thread* that forked the child exits, so
    children must not be started from the short-lived request threads.
    """

    def __init__(self):
        self._jobs = []
        self._cv = threading.Condition()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while True:
            with self._cv:
                while not self._jobs:
                    self._cv.wait()
                args, kwargs, box, done = self._jobs.pop(0)
            try:
                box["proc"] = subprocess.Popen(*args, **kwargs)
            except Exception as e:  # handed back to the caller
                box["error"] = e
            done.set()

    def popen(self, *args, **kwargs):
        box, done = {}, threading.Event()
        with self._cv:
            self._jobs.append((args, kwargs, box, done))
            self._cv.notify()
        done.wait()
        if "error" in box:
            raise box["error"]
        return box["proc"]


_spawner = _Spawner()


class ServerError(Exception):
    pass


class Server:
    """One llama-server process serving one model."""

    def __init__(self, llama_server, model, device, config, on_status):
        self.model = model
        self.port = self._free_port()
        self.tail = []
        cmd = [
            llama_server,
            "-hf", model,
            "--host", "127.0.0.1",
            "--port", str(self.port),
            "-ngl", "999",
            "-c", str(config.get("context") or 4096),
            "--jinja",
        ]
        if device:
            cmd += ["--device", device["name"]]
        cmd += [str(a) for a in config.get("extra_args") or []]
        log("starting:", " ".join(cmd))
        self.proc = _spawner.popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            preexec_fn=_die_with_parent if sys.platform.startswith("linux") else None,
        )
        self._on_status = on_status
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    @staticmethod
    def _free_port():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    def _pump_stderr(self):
        last_sent = 0.0
        for line in self.proc.stderr:
            line = line.strip()
            if not line:
                continue
            self.tail = (self.tail + [line])[-20:]
            now = time.monotonic()
            if now - last_sent > 0.5:
                last_sent = now
                self._on_status(line[:200])

    def wait_ready(self):
        url = f"http://127.0.0.1:{self.port}/health"
        while True:
            if self.proc.poll() is not None:
                raise ServerError("llama-server stopped: " + " | ".join(self.tail[-4:]))
            try:
                with urllib.request.urlopen(url, timeout=2) as r:
                    if r.status == 200:
                        return
            except (urllib.error.URLError, OSError):
                pass
            time.sleep(0.5)

    def chat(self, payload, on_token, should_stop=lambda: False):
        body = json.dumps({**payload, "stream": True}).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        text = []
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                for raw in r:
                    if should_stop():
                        break  # leaving the block closes the connection; llama-server stops generating
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    chunk = json.loads(data)
                    delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                    piece = delta.get("content")
                    if piece:
                        text.append(piece)
                        on_token(piece)
        except urllib.error.HTTPError as e:
            raise ServerError(f"llama-server returned {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")
        return "".join(text)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


class Engine:
    def __init__(self):
        self.config = load_config()
        self.llama_server = find_llama_server(self.config)
        self.devices = list_devices(self.llama_server) if self.llama_server else []
        self.device = pick_device(self.devices, self.config.get("device"))
        self.servers = {}  # kind -> Server
        self.lock = threading.Lock()
        self.cancelled = set()  # ids of chat requests the extension no longer wants

    def info(self):
        return {
            "version": VERSION,
            "llama_server": self.llama_server,
            "devices": self.devices,
            "device": self.device,
            "loaded": {kind: s.model for kind, s in self.servers.items()},
        }

    def ensure(self, kind, model, on_status):
        if not self.llama_server:
            raise ServerError("llama-server was not found. See the AegisTranslate README, section 'Local helper'.")
        with self.lock:
            current = self.servers.get(kind)
            if current and current.model == model and current.proc.poll() is None:
                return current
            if current:
                current.stop()
                del self.servers[kind]
            try:
                return self._start(kind, model, on_status)
            except ServerError:
                # Probably out of GPU memory: free the other model and try once more.
                if not self.servers:
                    raise
                on_status("Not enough GPU memory for both models, unloading the other one…")
                for other in list(self.servers):
                    self.servers.pop(other).stop()
                return self._start(kind, model, on_status)

    def _start(self, kind, model, on_status):
        on_status(f"Starting {model} on {self.device['description'] if self.device else 'default device'}…")
        server = Server(self.llama_server, model, self.device, self.config, on_status)
        try:
            server.wait_ready()
        except ServerError:
            server.stop()
            raise
        self.servers[kind] = server
        return server

    def unload(self, kind=None):
        with self.lock:
            for k in [kind] if kind else list(self.servers):
                server = self.servers.pop(k, None)
                if server:
                    server.stop()


# --- Request handling ---------------------------------------------------------


def handle(engine, msg):
    rid = msg.get("id")
    kind = msg.get("kind")

    def status(text):
        send({"id": rid, "type": "status", "text": text})

    try:
        if msg["type"] == "hello":
            send({"id": rid, "type": "result", **engine.info()})
        elif msg["type"] == "load":
            engine.ensure(kind, msg["model"], status)
            send({"id": rid, "type": "result", **engine.info()})
        elif msg["type"] == "unload":
            engine.unload(kind)
            send({"id": rid, "type": "result", **engine.info()})
        elif msg["type"] == "chat":
            server = engine.ensure(kind, msg["model"], status)
            try:
                text = ""
                if rid not in engine.cancelled:
                    text = server.chat(
                        msg["payload"],
                        lambda piece: send({"id": rid, "type": "token", "text": piece}),
                        lambda: rid in engine.cancelled,
                    )
            finally:
                engine.cancelled.discard(rid)
            send({"id": rid, "type": "result", "text": text})
        elif msg["type"] == "cancel":
            engine.cancelled.add(msg.get("target"))
        else:
            raise ServerError(f"unknown request type {msg['type']!r}")
    except Exception as e:  # report every failure to the extension instead of dying
        log("request failed:", repr(e))
        send({"id": rid, "type": "error", "error": str(e)})


def check():
    """`aegistranslate-helper --check`: print what the helper would use."""
    engine = Engine()
    print("llama-server:", engine.llama_server or "NOT FOUND")
    for d in engine.devices:
        print(f"  {d['name']}: {d['description']} ({d['total_mib']} MiB)")
    print("will use:", engine.device["description"] if engine.device else "llama.cpp default")
    return 0 if engine.llama_server else 1


def main():
    if "--check" in sys.argv:
        sys.exit(check())
    engine = Engine()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # runs the finally below
    try:
        while True:
            msg = read_message()
            if msg is None:  # Firefox disconnected
                break
            threading.Thread(target=handle, args=(engine, msg), daemon=True).start()
    finally:
        engine.unload()


if __name__ == "__main__":
    main()
