"""Picks the game engine: Person 1's stormgame package when it is importable, else the stand-in.

Set ENGINE=stub to force the stand-in.
"""
import os

ENGINE_NAME = "stub"
if os.environ.get("ENGINE", "auto") != "stub":
    try:
        from stormgame import Game  # noqa: F401
        ENGINE_NAME = "stormgame"
    except ImportError:
        pass

if ENGINE_NAME == "stub":
    from .stub_engine import Game  # noqa: F401
