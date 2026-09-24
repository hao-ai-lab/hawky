"""Token decoding proxy for the upstream Realtime-Venus ServingPort.

No model, GPU or agent is loaded here. Use the tokenizer.json from the SAME
checkpoint as the upstream model. All inference remains on that model server.
"""
import argparse
import asyncio
import os
import secrets
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from tokenizers import Tokenizer


class OutputDecoder:
    def __init__(self, tokenizer, mode):
        self.tokenizer, self.mode = tokenizer, mode
        self.generation, self.ids, self.text = None, [], ""

    def decode(self, output):
        if output["generation_id"] != self.generation:
            self.generation, self.ids, self.text = output["generation_id"], [], ""
        ids = output["total_token_ids"]
        if self.mode == "delta":
            self.ids.extend(ids)
        elif self.mode == "cumulative":
            if ids[:len(self.ids)] != self.ids:
                raise ValueError("Venus cumulative tokens changed an existing prefix")
            self.ids = list(ids)
        else:
            raise ValueError("Unsupported Venus raw_token_mode")
        if len(self.ids) > 32768:
            raise ValueError("Venus output exceeded the per-turn token limit")
        # Hold incomplete UTF-8 at the edge; never replace a previously emitted
        # prefix when the remaining byte tokens arrive in the next step.
        decoded = self.tokenizer.decode(self.ids, skip_special_tokens=False).rstrip("\ufffd")
        if not decoded.startswith(self.text):
            raise ValueError("Venus decoded text changed an emitted prefix")
        delta = decoded[len(self.text):]
        self.text = decoded
        return {**output, "text_delta": delta}


def create_app(upstream, tokenizer, api_key="", transport=None):
    sessions = {}
    client = httpx.AsyncClient(base_url=upstream.rstrip("/"), timeout=20, follow_redirects=False, transport=transport)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            for sid, state in list(sessions.items()):
                try:
                    await client.delete(f"/sessions/{sid}", params={"incarnation": state["incarnation"], "reason": "bridge_shutdown"})
                except httpx.HTTPError:
                    pass
            await client.aclose()

    app = FastAPI(lifespan=lifespan)

    @app.middleware("http")
    async def authenticate(request, call_next):
        expected = f"Bearer {api_key}"
        if api_key and not secrets.compare_digest(request.headers.get("authorization", ""), expected):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await call_next(request)

    @app.get("/hawk/health")
    async def health():
        try:
            r = await client.get("/healthz")
            return JSONResponse({"protocol": "hawk-venus/1", "upstream": r.json()}, status_code=r.status_code)
        except httpx.HTTPError:
            return JSONResponse({"error": "Venus model server is unavailable"}, status_code=503)

    @app.post("/sessions")
    async def start(request: Request):
        body = await request.json()
        sid = body.get("session_id", "")
        if not isinstance(sid, str) or not sid or len(sid) > 100 or not all(c.isalnum() or c in "-_" for c in sid):
            return JSONResponse({"error": "Invalid session ID"}, status_code=400)
        r = await client.post("/sessions", json=body)
        data = r.json()
        if r.is_success:
            special = data["capabilities"]["special_token_ids"]
            if not special or any(tokenizer.token_to_id(token) != value for token, value in special.items()):
                await client.delete(f"/sessions/{sid}", params={"incarnation": data["incarnation"], "reason": "tokenizer_mismatch"})
                return JSONResponse({"error": "Bridge tokenizer does not match the Venus checkpoint"}, status_code=502)
            # Never clear/reuse another client's live model state implicitly.
            sessions[sid] = {"incarnation": data["incarnation"], "lock": asyncio.Lock(),
                             "decoder": OutputDecoder(tokenizer, data["capabilities"]["raw_token_mode"])}
        return JSONResponse(data, status_code=r.status_code)

    @app.api_route("/sessions/{sid}/{operation}", methods=["POST"])
    async def operation(sid: str, operation: str, request: Request):
        if operation not in {"audio", "video_frame", "prefill", "output", "playback_ack"}:
            return JSONResponse({"error": "Unsupported operation"}, status_code=404)
        state = sessions.get(sid)
        if not state:
            return JSONResponse({"error": "Session not owned by this bridge"}, status_code=404)
        raw = await request.body()
        if len(raw) > 600000:
            return JSONResponse({"error": "Packet too large"}, status_code=413)
        async def forward():
            r = await client.post(f"/sessions/{sid}/{operation}", params=request.query_params,
                                  content=raw, headers={"content-type": "application/json"})
            data = r.json()
            if operation == "output" and r.is_success:
                data = state["decoder"].decode(data)
            return JSONResponse(data, status_code=r.status_code)
        if operation == "output":
            async with state["lock"]:
                return await forward()
        return await forward()

    @app.delete("/sessions/{sid}")
    async def close(sid: str, request: Request):
        if sid not in sessions:
            return JSONResponse({"error": "Unknown session"}, status_code=404)
        r = await client.delete(f"/sessions/{sid}", params=request.query_params)
        if r.is_success or r.status_code == 410:
            sessions.pop(sid, None)
        return JSONResponse(r.json(), status_code=r.status_code)

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", default="http://127.0.0.1:8031")
    parser.add_argument("--tokenizer", required=True, help="Checkpoint tokenizer.json (local file)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8033)
    args = parser.parse_args()
    uvicorn.run(create_app(args.upstream, Tokenizer.from_file(args.tokenizer), os.getenv("HAWKY_VENUS_API_KEY", "")), host=args.host, port=args.port)
