"""Serve the static Hawk landing site on Modal.

Deploy a persistent preview URL:
    modal deploy deploy_modal.py
Ephemeral hot-reload preview:
    modal serve deploy_modal.py
"""
from pathlib import Path

import modal

BASE = Path(__file__).resolve().parent

# Ship only the deliverable: index.html + assets/ (skip .build/ design notes + this script).
image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]")
    .add_local_file(BASE / "index.html", "/site/index.html")
    .add_local_dir(BASE / "assets", "/site/assets")
)

app = modal.App("hawk-site")


@app.function(image=image, scaledown_window=300)
@modal.asgi_app()
def web():
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles

    api = FastAPI()
    api.mount("/", StaticFiles(directory="/site", html=True), name="site")
    return api
