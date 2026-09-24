import unittest
import time
import httpx
from fastapi.testclient import TestClient
from bridge import OutputDecoder, create_app


class FakeTokenizer:
    def decode(self, ids, **_):
        return {(): "", (1,): "hi \ufffd", (1, 2): "hi 猫"}.get(tuple(ids), "changed")

    def token_to_id(self, token):
        return 42 if token == "<delegate>" else None


class BridgeTests(unittest.TestCase):
    def test_idle_gateway_releases_only_its_owned_session(self):
        deleted = []
        def upstream(req):
            if req.method == "DELETE":
                deleted.append(str(req.url))
                return httpx.Response(200, json={"ok": True})
            return httpx.Response(200, json={"incarnation": 1, "capabilities": {"raw_token_mode": "delta", "special_token_ids": {"<delegate>": 42}}})
        app = create_app("http://fixture", FakeTokenizer(), transport=httpx.MockTransport(upstream), idle_seconds=0.03)
        with TestClient(app) as client:
            client.post("/sessions", json={"session_id": "owned"})
            for _ in range(50):
                if deleted:
                    break
                time.sleep(0.01)
            self.assertEqual(len(deleted), 1)
            self.assertIn("/sessions/owned?incarnation=1&reason=bridge_idle", deleted[0])
            self.assertEqual(client.post("/sessions/owned/output").status_code, 404)

    def test_incremental_unicode_and_cumulative_prefix(self):
        decoder = OutputDecoder(FakeTokenizer(), "delta")
        self.assertEqual(decoder.decode({"generation_id": "a", "total_token_ids": [1]})["text_delta"], "hi ")
        self.assertEqual(decoder.decode({"generation_id": "a", "total_token_ids": [2]})["text_delta"], "猫")
        decoder = OutputDecoder(FakeTokenizer(), "cumulative")
        decoder.decode({"generation_id": "a", "total_token_ids": [1]})
        with self.assertRaises(ValueError):
            decoder.decode({"generation_id": "a", "total_token_ids": [2]})

    def test_authenticated_proxy_owns_sessions_and_decodes_output(self):
        requests = []
        def upstream(req):
            requests.append(req)
            if req.url.path == "/sessions":
                return httpx.Response(200, json={"incarnation": 1, "capabilities": {"raw_token_mode": "delta", "special_token_ids": {"<delegate>": 42}}})
            if req.url.path.endswith("/output"):
                return httpx.Response(200, json={"generation_id": "g", "total_token_ids": [1]})
            return httpx.Response(200, json={"ok": True})
        app = create_app("http://fixture", FakeTokenizer(), "secret", httpx.MockTransport(upstream))
        with TestClient(app) as client:
            self.assertEqual(client.get("/hawk/health").status_code, 401)
            client.headers["Authorization"] = "Bearer secret"
            self.assertEqual(client.post("/sessions/foreign/output").status_code, 404)
            self.assertEqual(client.post("/sessions", json={"session_id": "test"}).status_code, 200)
            self.assertEqual(client.post("/sessions/test/output?incarnation=1").json()["text_delta"], "hi ")
            self.assertEqual(client.post("/sessions/test/arbitrary").status_code, 404)
        self.assertEqual(requests[-1].method, "DELETE")


if __name__ == "__main__":
    unittest.main()
