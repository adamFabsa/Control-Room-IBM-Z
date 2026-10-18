"""Demo autopilot, inside the server: plays the storm for a recorded demo when the page was opened with
?autopilot and the player pressed Start the storm. Without that flag the game never plays for the player.

The same moves as scripts/demo_autopilot.py, acting on the session directly: it meets the order with the
warmest neighborhoods, swaps cold dark neighborhoods for warm powered ones, restores what is no longer needed,
and cuts the dialysis circuit once so the game raises its most important card. Cards wait CARD_WAIT seconds
for the player (the Grid Status Box's red button or a click), then take the AI pick. Pause stays the
player's. Measured on the real engine: about 5.5 million cold person-hours at speed 4, against 36.5 million
for the 2021 playbook.
"""
import asyncio
import logging
import time

log = logging.getLogger("controlroom.autopilot")

# used only when the player placed nothing in Get ready: 8 of 10 points, 2 left for an emergency generator
PLAN = [
    {"type": "buy", "item": "generator", "target": "hospital-1"},
    {"type": "buy", "item": "generator", "target": "water-1"},
    {"type": "buy", "item": "keep_gas", "target": "gas-1"},
    {"type": "buy", "item": "warming_center", "target": "school-1"},
    {"type": "buy", "item": "repair_crews"},
]
SPEED = 4
CARD_WAIT = 6.0  # seconds a card waits for the player before the autopilot takes the AI pick
HOLD_SHOW = 1.5  # seconds the "clock stopped" banner stays up before the autopilot cuts
GAP = 0.25  # seconds between rounds of map moves, so each cut is seen and heard
STICKY = 4  # °F: a dark neighborhood is swapped back only when it is this much colder than a powered one
FIXES = 3  # moves planned per round
CRITICAL = {"hospital", "dialysis", "water_plant", "gas_compressor"}
DIALYSIS_CIRCUIT, DIALYSIS_ORDER_MW = "C-03", 900


def place_plan_if_empty(session):
    """Get ready with nothing placed: put the autopilot's winter plan in, so the storm isn't played bare."""
    if any(e["action"]["type"] == "buy" for e in session.log):
        return
    for action in PLAN:
        try:
            session._engine_action(action)
        except Exception as e:
            log.warning("autopilot plan: %s skipped (%s)", action.get("item"), e)


def _unbacked(s):
    """Circuits whose cut would darken a critical building with no working backup."""
    keep_gas = bool((s.get("prep") or {}).get("keep_gas"))
    out = set()
    for b in s["buildings"]:
        backed = (b.get("generator") and (b.get("fuel_h") is None or b["fuel_h"] > 0.5)) or (
            b["type"] == "gas_compressor" and keep_gas)
        if b["type"] in CRITICAL and not backed:
            out.add(b["circuit"])
    return out


def _base(c):
    return c.get("parent") or c["id"]


def next_moves(s, dialysis_done):
    """Up to FIXES moves, planned on a running copy of the numbers: cut the warmest neighborhood when short;
    restore the coldest dark one when there is room; otherwise swap the coldest dark neighborhood for the warmest
    powered one (cut first, so the order is never missed). Returns [(action, tag)]."""
    order, cut = s["order_mw"], s["cut_mw"]
    risky = _unbacked(s)
    on = sorted((c for c in s["circuits"] if c["on"] and not c["protected"] and _base(c) not in risky),
                key=lambda c: -c["indoor_f"])
    dark = sorted((c for c in s["circuits"] if not c["on"] and not c.get("broken")), key=lambda c: c["indoor_f"])
    if not dialysis_done and order >= DIALYSIS_ORDER_MW and DIALYSIS_CIRCUIT in risky:
        c = next((c for c in s["circuits"] if c["on"] and _base(c) == DIALYSIS_CIRCUIT), None)
        if c:
            return [({"type": "cut", "circuit": c["id"]}, "dialysis")]
    out = []
    while len(out) < FIXES:
        if order > 0 and cut < order * 1.02:
            if not on:
                break
            c = on.pop(0)
            out.append(({"type": "cut", "circuit": c["id"]}, ""))
            cut += c["mw"]
            continue
        fit = next((c for c in dark if c["mw"] <= cut - order * 1.02), None)
        if fit:
            dark.remove(fit)
            out.append(({"type": "restore", "circuit": fit["id"]}, ""))
            cut -= fit["mw"]
            continue
        if dark and on and dark[0]["indoor_f"] + STICKY < on[0]["indoor_f"]:
            w, d = on.pop(0), dark.pop(0)
            out += [({"type": "cut", "circuit": w["id"]}, ""), ({"type": "restore", "circuit": d["id"]}, "")]
            cut += w["mw"] - d["mw"]
            continue
        break
    return out


async def run(session, game):
    """Plays until the storm ends or the session moves to another game."""
    log.info("autopilot: playing the storm")
    dialysis_done, held_since, last = False, None, 0.0
    card_seen = {}
    try:
        await session.handle({"type": "speed", "value": SPEED})
        while session.game is game:
            s = session.state()
            if s["phase"] == "over":
                break
            event = s.get("event")
            if event:  # the player's call first: the box's red button or a click
                if time.monotonic() - card_seen.setdefault(event["id"], time.monotonic()) >= CARD_WAIT:
                    pick = next((o for o in event["options"] if o.get("ai_pick")), event["options"][0])
                    log.info("autopilot: no call on %r after %.0f s, taking the AI pick %r", event["title"], CARD_WAIT, pick["label"])
                    await session.handle({"type": "choose", "event": event["id"], "option": pick["id"]})
                await asyncio.sleep(0.2)
                continue
            if s.get("hold"):  # let the banner be seen, then cut
                held_since = held_since or time.monotonic()
                if time.monotonic() - held_since < HOLD_SHOW:
                    await asyncio.sleep(0.1)
                    continue
            else:
                held_since = None
                if s["paused"]:  # the player paused: wait
                    await asyncio.sleep(0.2)
                    continue
            if time.monotonic() - last >= GAP:
                for action, tag in next_moves(s, dialysis_done):
                    try:
                        await session.handle(action)
                    except Exception:
                        break
                    # stop the round if the move didn't land or opened a card (a cut that would darken a building
                    # asks first), so the restore half of a swap never runs without its cut
                    after = session.game.state()
                    c = next((c for c in after["circuits"] if c["id"] == action["circuit"]), None)
                    landed = c is not None and c["on"] == (action["type"] == "restore")
                    if tag == "dialysis":
                        log.info("autopilot: cut %s for the dialysis card at order %.0f MW -> landed=%s event=%s",
                                 action["circuit"], s["order_mw"], landed, (after.get("event") or {}).get("kind"))
                    if tag == "dialysis" and (landed or (after.get("event") or {}).get("kind") == "critical_cut"):
                        dialysis_done = True  # the card is up (or the cut went through): once is enough
                    if not landed or after.get("event"):
                        break
                last = time.monotonic()
            await asyncio.sleep(0.05)
    except asyncio.CancelledError:
        raise
    except Exception:
        log.exception("autopilot stopped")
    finally:
        if session.game is game:
            session.autopilot = False
        log.info("autopilot: done")
