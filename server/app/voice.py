"""The voice guide: ElevenLabs text-to-speech for a few lines the server writes from the live game.

The browser asks for a line by name, never sends text, so the API key (ELEVENLABS_API_KEY, in the VM's .env only)
can't be used to say anything else, and every number spoken comes from the game. Audio is cached by its text.
"""
import asyncio
import hashlib
import json
import logging
import os
import re
import time
import urllib.request
from collections import deque

log = logging.getLogger("controlroom.voice")

API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_flash_v2_5")
URL = "https://api.elevenlabs.io/v1/text-to-speech/{voice}"
_cache: dict[str, bytes] = {}
# The site is public, so anyone can ask for lines. Lines already spoken come from the cache for free; new ones
# spend ElevenLabs credits, so they are capped for everyone together: per minute, and characters per day.
MAX_PER_MINUTE = int(os.environ.get("VOICE_MAX_PER_MINUTE", "20"))
DAILY_CHARS = int(os.environ.get("VOICE_DAILY_CHARS", "10000"))
_recent = deque()  # times of the last minute's new lines
_today = {"date": None, "chars": 0}


class Throttled(Exception):
    """Over the voice guide's budget; the game goes on without it."""


def _spend(text):
    now = time.time()
    while _recent and now - _recent[0] > 60:
        _recent.popleft()
    if len(_recent) >= MAX_PER_MINUTE:
        raise Throttled("the voice guide is busy; it speaks again in a minute")
    date = time.strftime("%Y-%m-%d")
    if _today["date"] != date:
        _today.update(date=date, chars=0)
    if _today["chars"] + len(text) > DAILY_CHARS:
        raise Throttled("the voice guide has used today's budget")
    _recent.append(now)
    _today["chars"] += len(text)

LINES = ("intro", "storm", "order", "card", "short", "cold", "report")


def enabled():
    return bool(API_KEY)


def _mw(n):
    return f"{round(n):,} megawatts"


def line_text(line, state, report=None):
    """The sentence for a line, from the current game; None if it doesn't apply right now."""
    if line == "intro":
        return ("Welcome to Lights Out. A winter storm reaches Dallas County in three days. "
                "Spend your ten points to get ready, then start the storm.")
    if line == "storm":
        return ("The storm is here. Watch the cut order at the top of the screen and cut neighborhoods to meet it. "
                "Homes cool fast without power, so rotate who goes dark.")
    if line == "order" and state.get("order_mw", 0) > 0:
        return f"The grid operator orders {_mw(state['order_mw'])} of cuts. Pick the neighborhoods to cut."
    if line == "card" and state.get("event"):
        event = state["event"]
        pick = next((o["label"] for o in event["options"] if o.get("ai_pick")), None)
        pick = pick and re.sub(r"\s*\(\d+ pts?\)", "", pick)  # "(2 pts)" reads badly aloud
        return f"{event['title']} " + (f"The AI suggests: {pick}." if pick else "Your call.")
    if line == "short" and state.get("order_mw", 0) > state.get("cut_mw", 0):
        return f"You are {_mw(state['order_mw'] - state['cut_mw'])} short. Cut more, or the grid will collapse."
    if line == "cold":
        return "Homes are getting cold. Restore their power, or open a warming center."
    if line == "report" and report:
        d = report.get("estimated_deaths") or {}
        you = d.get("player")
        text = "The storm is over. " + ("You beat the twenty twenty-one playbook. " if report.get("beat_playbook") else
                                        "The twenty twenty-one playbook did better this time. ")
        if you is not None:
            text += f"An estimated {you} deaths in Dallas County, against the twenty-two the state confirmed in twenty twenty-one."
        return text
    return None


def _synthesize(text):
    body = json.dumps({"text": text, "model_id": MODEL,
                       "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}).encode()
    request = urllib.request.Request(URL.format(voice=VOICE_ID), body,
                                     {"xi-api-key": API_KEY, "content-type": "application/json", "accept": "audio/mpeg"})
    with urllib.request.urlopen(request, timeout=30) as r:
        return r.read()


async def speak(text):
    """MP3 bytes for the text (cached), or None if the voice is off or ElevenLabs fails. Raises Throttled when a
    new line would go over the per-minute or daily budget."""
    if not enabled() or not text:
        return None
    key = hashlib.sha256(f"{VOICE_ID}|{MODEL}|{text}".encode()).hexdigest()
    if key not in _cache:
        _spend(text)  # raises Throttled past the budget
        try:
            _cache[key] = await asyncio.to_thread(_synthesize, text)
        except Exception as e:
            log.warning("ElevenLabs failed: %s", e)
            return None
    return _cache[key]
