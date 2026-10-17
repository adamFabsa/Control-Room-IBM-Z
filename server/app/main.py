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

from . import analyst
from .engine import ENGINE_NAME
from .report import baselines, build_report
from .session import GameSession

logging.basicConfig(level=logging.INFO)
MODELS = Path(__file__).resolve().parents[2] / "ai" / "models"
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


def _cpu():
    info = Path("/proc/cpuinfo").read_text() if Path("/proc/cpuinfo").exists() else ""
    machine = next((line.split("machine = ")[1].strip() for line in info.splitlines() if "machine = " in line), None)
    features = next((line.split(":", 1)[1].split() for line in info.splitlines() if line.startswith("features")), [])
    names = {"3931": "IBM z16", "3932": "IBM z16", "9175": "IBM z17", "9176": "IBM z17"}
    return {"arch": platform.machine(), "machine_type": machine, "model": names.get(machine, machine),
            "cores": os.cpu_count(), "nnpa_ai_accelerator": "nnpa" in features, "cpacf_crypto": "msa" in features}


@app.get("/api/ai")
def get_ai():
    """Evidence for the video: the hardware and every AI part's numbers."""
    m1 = MODELS / "m1_meta.json"
    job = session.job
    return {"platform": _cpu(),
            "m1_forecast": json.loads(m1.read_text())["metrics"] if m1.exists() else None,
            "m3_analyst": analyst.summary_stats(),
            "records": session.records.stats(),
            "last_report": {"turning_points": job.turning_points_run,
                            "stress_test": {k: job.stress.get(k) for k in ("status", "storms", "seconds", "cores")}}}


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
    session.finish()
    snapshot = session.snapshot()
    base = await asyncio.to_thread(baselines, session.storm, session.seed)
    return build_report(snapshot, base, session.job)


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
