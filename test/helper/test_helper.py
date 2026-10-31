"""End-to-end test of the native-messaging helper against a fake llama-server."""
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "..", "helper", "aegistranslate_helper.py")


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.log = os.path.join(self.tmp.name, "calls.log")
        env = {
            **os.environ,
            "AEGIS_LLAMA_SERVER": os.path.join(HERE, "fake_llama_server.py"),
            "XDG_CONFIG_HOME": self.tmp.name,
            "FAKE_LOG": self.log,
        }
        self.proc = subprocess.Popen(
            [sys.executable, HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env
        )
        self.next_id = 0

    def tearDown(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=15)
        self.proc.stdout.close()
        self.tmp.cleanup()

    def request(self, **msg):
        self.next_id += 1
        msg["id"] = self.next_id
        data = json.dumps(msg).encode()
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()
        events = []
        while True:
            (n,) = struct.unpack("<I", self.proc.stdout.read(4))
            event = json.loads(self.proc.stdout.read(n))
            self.assertEqual(event["id"], self.next_id)
            events.append(event)
            if event["type"] in ("result", "error"):
                return events

    def calls(self):
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def starts(self):
        return [c for c in self.calls() if "-hf" in c]

    def test_hello_picks_largest_gpu(self):
        [result] = self.request(type="hello")
        self.assertEqual(result["device"]["name"], "CUDA0")
        self.assertEqual(len(result["devices"]), 2)

    def test_dedicated_gpu_beats_integrated_with_more_shared_memory(self):
        # A real Vulkan build on a Ryzen 5700G + RTX 3060 Ti desktop: the iGPU
        # reports shared system RAM and looks three times bigger.
        os.environ["FAKE_DEVICES"] = json.dumps([
            "Vulkan0: AMD Radeon Graphics (RADV RENOIR) (25063 MiB, 24089 MiB free)",
            "Vulkan1: NVIDIA GeForce RTX 3060 Ti (8438 MiB, 7776 MiB free)",
        ])
        try:
            sys.path.insert(0, os.path.dirname(HELPER))
            import aegistranslate_helper as h
            devices = h.list_devices(os.path.join(HERE, "fake_llama_server.py"))
        finally:
            del os.environ["FAKE_DEVICES"]
        self.assertEqual(h.pick_device(devices, None)["name"], "Vulkan1")
        self.assertEqual(h.pick_device(devices, "Vulkan0")["name"], "Vulkan0")
        names = {
            "AMD Radeon 780M Graphics": True,
            "AMD Radeon(TM) Vega 8 Graphics": True,
            "Intel(R) UHD Graphics 770": True,
            "Intel(R) Iris(R) Xe Graphics": True,
            "Intel(R) Arc(TM) Graphics": True,
            "Intel(R) Arc(TM) 140V GPU (16GB)": True,
            "AMD Radeon RX 7900 XTX (RADV NAVI31)": False,
            "AMD Radeon Pro W6800": False,
            "Intel(R) Arc(TM) A770 Graphics": False,
            "NVIDIA GeForce RTX 3060 Ti": False,
        }
        for name, integrated in names.items():
            self.assertEqual(h.is_integrated({"description": name}), integrated, name)

    def test_chat_streams_tokens_and_uses_device(self):
        payload = {"messages": [{"role": "user", "content": "hello"}], "chat_template_kwargs": {"enable_thinking": False}}
        events = self.request(type="chat", kind="text", model="Qwen/Qwen3-4B-GGUF:Q4_K_M", payload=payload)
        tokens = "".join(e["text"] for e in events if e["type"] == "token")
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(events[-1]["text"], tokens)
        self.assertEqual(tokens, 'ECHO hello kwargs={"enable_thinking": false}')
        [args] = self.calls()
        args = args[: args.index("--pid")]
        self.assertEqual(args[args.index("-hf") + 1], "Qwen/Qwen3-4B-GGUF:Q4_K_M")
        self.assertEqual(args[args.index("--device") + 1], "CUDA0")
        self.assertEqual(args[args.index("--host") + 1], "127.0.0.1")

    def test_server_is_reused_and_replaced(self):
        payload = {"messages": [{"role": "user", "content": "x"}]}
        self.request(type="chat", kind="text", model="a/one", payload=payload)
        self.request(type="chat", kind="text", model="a/one", payload=payload)
        self.assertEqual(len(self.starts()), 1)
        self.request(type="chat", kind="text", model="a/two", payload=payload)
        self.assertEqual(len(self.starts()), 2)
        [hello] = self.request(type="hello")
        self.assertEqual(hello["loaded"], {"text": "a/two"})

    def test_server_survives_after_its_request_finishes(self):
        # Regression: PR_SET_PDEATHSIG is per thread, so a server started from a
        # request thread used to be killed when that thread ended.
        payload = {"messages": [{"role": "user", "content": "x"}]}
        self.request(type="chat", kind="text", model="a/one", payload=payload)
        time.sleep(1.5)
        self.request(type="chat", kind="text", model="a/one", payload=payload)
        self.assertEqual(len(self.starts()), 1, "llama-server was restarted")

    def test_cancel_stops_streaming(self):
        payload = {"messages": [{"role": "user", "content": "SLOW " + "word " * 40}]}
        self.next_id += 1
        rid = self.next_id
        data = json.dumps({"id": rid, "type": "chat", "kind": "text", "model": "a/one", "payload": payload}).encode()
        self.proc.stdin.write(struct.pack("<I", len(data)) + data)
        self.proc.stdin.flush()
        started = time.monotonic()
        tokens = 0
        while True:
            (n,) = struct.unpack("<I", self.proc.stdout.read(4))
            event = json.loads(self.proc.stdout.read(n))
            if event["type"] == "token":
                tokens += 1
                if tokens == 2:
                    cancel = json.dumps({"type": "cancel", "target": rid}).encode()
                    self.proc.stdin.write(struct.pack("<I", len(cancel)) + cancel)
                    self.proc.stdin.flush()
            elif event["type"] in ("result", "error"):
                break
        self.assertEqual(event["type"], "result")
        self.assertLess(time.monotonic() - started, 4, "cancel did not stop the stream")
        deadline = time.monotonic() + 5
        while ["cancelled"] not in self.calls() and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertIn(["cancelled"], self.calls(), "llama-server kept generating")

    def test_image_message(self):
        content = [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}, {"type": "text", "text": "read"}]
        events = self.request(type="chat", kind="vision", model="v/l", payload={"messages": [{"role": "user", "content": content}]})
        self.assertTrue(events[-1]["text"].startswith("IMAGE image_url,text"))

    def test_failed_model_reports_error(self):
        events = self.request(type="load", kind="text", model="broken/model")
        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("failed to load model", events[-1]["error"])

    def test_disconnect_stops_servers(self):
        self.request(type="load", kind="text", model="a/one")
        [args] = self.calls()
        pid = int(args[args.index("--pid") + 1])
        self.proc.stdin.close()
        self.proc.wait(timeout=15)
        deadline = time.monotonic() + 5
        while os.path.exists(f"/proc/{pid}") and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(os.path.exists(f"/proc/{pid}"), "llama-server still running after disconnect")

    def test_killed_helper_takes_server_down(self):
        self.request(type="load", kind="text", model="a/one")
        [args] = self.calls()
        pid = int(args[args.index("--pid") + 1])
        self.proc.kill()
        self.proc.wait(timeout=15)
        deadline = time.monotonic() + 5
        while os.path.exists(f"/proc/{pid}") and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertFalse(os.path.exists(f"/proc/{pid}"), "llama-server survived a killed helper")


if __name__ == "__main__":
    unittest.main()
