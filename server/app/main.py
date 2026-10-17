"""CONTROL ROOM: URI game server. Runs the storm clock on LinuxONE and talks to browsers and the hardware bridge."""
import asyncio
import json
import logging
import os
import platform
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .engine import ENGINE_NAME
from .report import baselines, build_report
from .session import GameSession

logging.basicConfig(level=logging.INFO)
session = GameSession()


@asynccontextmanager
async def lifespan(app):
    clock = asyncio.create_task(session.run_clock())
    yield
    clock.cancel()


app = FastAPI(title="CONTROL ROOM: URI", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _reason(e):
    return f"missing field {e}" if isinstance(e, KeyError) else str(e)


@app.get("/api/health")
def health():
    return {"ok": True, "engine": ENGINE_NAME, "arch": platform.machine(),
            "cores": os.cpu_count(), "clients": len(session.clients)}


@app.get("/api/state")
async def get_state():
    return session.state()


@app.get("/api/records")
def get_records():
    return session.records.stats()


@app.post("/api/action")
async def post_action(action: dict = Body(...)):
    try:
        await session.handle(action)
    except Exception as e:
        raise HTTPException(400, _reason(e))
    return session.state()


@app.get("/api/report")
async def get_report():
    # Snapshot on the event loop so the clock can't change the game mid-read; baselines run in a thread.
    snapshot = {"storm": session.storm, "seed": session.seed, "phase": session.game.state()["phase"],
                "score": session.game.score(), "history": list(session.history), "log": list(session.log)}
    base = await asyncio.to_thread(baselines, session.storm, session.seed)
    return build_report(snapshot, base)


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    session.clients.add(websocket)
    try:
        await websocket.send_json(session.state())
        while True:
            text = await websocket.receive_text()
            try:
                await session.handle(json.loads(text))
            except Exception as e:
                await websocket.send_json({"error": _reason(e)})
    except WebSocketDisconnect:
        pass
    finally:
        session.clients.discard(websocket)


# Serve the built game screens from the same server when web/dist exists.
web_dist = Path(__file__).resolve().parents[2] / "web" / "dist"
if web_dist.is_dir():
    app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")
