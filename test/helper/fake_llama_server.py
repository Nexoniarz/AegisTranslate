#!/usr/bin/env python3
"""Stand-in for llama.cpp's llama-server, for testing the helper without a GPU."""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

args = sys.argv[1:]
if "--list-devices" in args:
    print("Available devices:")
    print("  Vulkan0: AMD Radeon Graphics (RADV RENOIR) (4096 MiB, 3900 MiB free)")
    print("  CUDA0: NVIDIA GeForce RTX 3060 Ti (8192 MiB, 7800 MiB free)")
    sys.exit(0)

opts = dict(zip(args[::2], args[1::2]))
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(args + ["--pid", str(os.getpid())]) + "\n")
if opts.get("-hf") == "broken/model":
    print("error: failed to load model", file=sys.stderr)
    sys.exit(1)
print("loading model...", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        content = body["messages"][-1]["content"]
        if isinstance(content, list):
            reply = "IMAGE " + ",".join(part["type"] for part in content)
        else:
            reply = "ECHO " + content
        reply += " kwargs=" + json.dumps(body.get("chat_template_kwargs"))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        slow = "SLOW" in json.dumps(body["messages"])
        try:
            for i in range(0, len(reply), 7):
                chunk = {"choices": [{"delta": {"content": reply[i : i + 7]}}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
                if slow:
                    time.sleep(0.3)
            self.wfile.write(b"data: [DONE]\n\n")
            if slow:
                with open(os.environ["FAKE_LOG"], "a") as f:
                    f.write(json.dumps(["completed"]) + "\n")
        except OSError:
            with open(os.environ["FAKE_LOG"], "a") as f:
                f.write(json.dumps(["cancelled"]) + "\n")


ThreadingHTTPServer(("127.0.0.1", int(opts["--port"])), Handler).serve_forever()
