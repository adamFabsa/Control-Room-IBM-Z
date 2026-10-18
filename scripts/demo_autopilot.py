"""Demo autopilot: plays Lights Out through the server's API while the presenter talks and works the
Grid Status Box. For recording the demo only; the game itself never plays for the player.

  ssh -i ~/Downloads/datathon.pem linux1@148.100.98.237
  python3 ~/control-room/scripts/demo_autopilot.py                   # on the VM, next to the live game

What it does, and what it leaves to the box:
  Get ready  places a winter plan one item at a time, keeping 2 points for an emergency generator.
             Then waits for the box's GREEN button to start the storm (or starts by itself after --start-wait).
  Storm      meets the cut order with the warmest neighborhoods, swaps cold dark neighborhoods for warm
             powered ones, and restores what is no longer needed (about 5.5 million cold person-hours on the real
             engine, against 36.5 million for the 2021 playbook). Run it on the VM: from a laptop each move waits
             on the network and it falls behind. Once, when the order passes 900 MW, it cuts Southwest Dallas,
             whose dialysis center has no backup, so the game raises its most important card.
  Cards      the box beeps; press RED (confirm) to take the AI pick. After --card-wait seconds without a
             press, the autopilot takes the AI pick itself. GREEN pauses and YELLOW changes speed at any time.
  The end    prints the report's headline numbers for the narrator.

Standard library only.
"""
import argparse
import json
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
parser.add_argument("--server", default="http://localhost:8000")
parser.add_argument("--speed", type=int, default=4, help="game speed once the storm starts, 1-5 (0: leave it)")
parser.add_argument("--card-wait", type=float, default=6.0, help="seconds to wait for the box's confirm button")
parser.add_argument("--start-wait", type=float, default=20.0, help="seconds to wait for the green button")
parser.add_argument("--prep-gap", type=float, default=1.6, help="seconds between Get-ready placements")
parser.add_argument("--gap", type=float, default=0.25, help="seconds between rounds of map moves")
parser.add_argument("--sticky", type=float, default=4, help="°F colder a dark neighborhood must be to swap it back")
args = parser.parse_args()

PLAN = [  # 8 of 10 points; 2 stay free for an emergency generator on a card
    ({"type": "buy", "item": "generator", "target": "hospital-1"}, "a generator at the hospital"),
    ({"type": "buy", "item": "generator", "target": "water-1"}, "a generator at the water plant"),
    ({"type": "buy", "item": "keep_gas", "target": "gas-1"}, "gas kept flowing at the compressor"),
    ({"type": "buy", "item": "warming_center", "target": "school-1"}, "a warming center at the South Dallas school"),
    ({"type": "buy", "item": "repair_crews"}, "repair crews on standby"),
]
CRITICAL = {"hospital", "dialysis", "water_plant", "gas_compressor"}
DIALYSIS_CIRCUIT, DIALYSIS_ORDER_MW = "C-03", 900
ACTION_GAP = args.gap  # seconds between rounds of map moves, so each cut is seen and heard
STICKY = args.sticky  # °F: a dark neighborhood is swapped back only when it is this much colder than a powered one
FIXES = 3  # moves planned per tick


def call(path, body=None):
    request = urllib.request.Request(args.server + path, json.dumps(body).encode() if body else None,
                                     {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        print("  server said no:", e.read().decode(errors="ignore")[:160])
    except (urllib.error.URLError, TimeoutError) as e:
        print("  server not reachable:", e)
    return None


def state():
    while True:
        s = call("/api/state")
        if s:
            return s
        time.sleep(1)


def act(action):
    return call("/api/action", action)


def say(text):
    print(time.strftime("%H:%M:%S"), text, flush=True)


def unbacked(s):
    """Circuits whose cut would darken a critical building with no working backup."""
    keep_gas = bool((s.get("prep") or {}).get("keep_gas"))
    out = set()
    for b in s["buildings"]:
        backed = (b.get("generator") and (b.get("fuel_h") is None or b["fuel_h"] > 0.5)) or (
            b["type"] == "gas_compressor" and keep_gas)
        if b["type"] in CRITICAL and not backed:
            out.add(b["circuit"])
    return out


def base(c):
    return c.get("parent") or c["id"]


def next_moves(s, dialysis_done):
    """Up to FIXES moves, planned on a running copy of the numbers, the way a steady operator works: cut the
    warmest neighborhood when short; restore the coldest dark one when there is room; otherwise swap the
    coldest dark neighborhood for the warmest powered one (cut first, so the order is never missed). Dark ones
    count STICKY degrees warmer, so a swap only happens when it helps. Simulated on the real engine with the
    server's card rules and on the VM: about 5.5 million cold person-hours at speed 4, against 36.5 million for the 2021 playbook."""
    order, cut = s["order_mw"], s["cut_mw"]
    risky = unbacked(s)
    on = sorted((c for c in s["circuits"] if c["on"] and not c["protected"] and base(c) not in risky),
                key=lambda c: -c["indoor_f"])
    dark = sorted((c for c in s["circuits"] if not c["on"] and not c.get("broken")), key=lambda c: c["indoor_f"])
    cut_ = lambda c, why="": ({"type": "cut", "circuit": c["id"]}, f"cut {c['area']} {c['id']} ({c['indoor_f']}°F inside){why}")
    restore = lambda c: ({"type": "restore", "circuit": c["id"]}, f"restore {c['area']} {c['id']} ({c['indoor_f']}°F inside)")
    if not dialysis_done and order >= DIALYSIS_ORDER_MW and DIALYSIS_CIRCUIT in risky:
        c = next((c for c in s["circuits"] if c["on"] and base(c) == DIALYSIS_CIRCUIT), None)
        if c:
            return [cut_(c, ": its dialysis center has no backup")]
    out = []
    while len(out) < FIXES:
        if order > 0 and cut < order * 1.02:
            if not on:
                break
            c = on.pop(0)
            out.append(cut_(c))
            cut += c["mw"]
            continue
        fit = next((c for c in dark if c["mw"] <= cut - order * 1.02), None)
        if fit:
            dark.remove(fit)
            out.append(restore(fit))
            cut -= fit["mw"]
            continue
        if dark and on and dark[0]["indoor_f"] + STICKY < on[0]["indoor_f"]:
            w, d = on.pop(0), dark.pop(0)
            out += [cut_(w, ", swapping"), restore(d)]
            cut += w["mw"] - d["mw"]
            continue
        break
    return out


def card(s):
    ev = s["event"]
    pick = next((o for o in ev["options"] if o.get("ai_pick")), ev["options"][0])
    say(f"CARD  {ev['title']}")
    say(f"      AI pick: {pick['label']}  -> press RED on the box (or I take it in {args.card_wait:.0f} s)")
    end = time.time() + args.card_wait
    while time.time() < end:
        time.sleep(0.2)
        now = state()
        if (now.get("event") or {}).get("id") != ev["id"]:
            say("      answered on the box")
            return
    now = state()
    if (now.get("event") or {}).get("id") == ev["id"]:
        pick = next((o for o in now["event"]["options"] if o.get("ai_pick")), now["event"]["options"][0])
        act({"type": "choose", "event": ev["id"], "option": pick["id"]})
        say(f"      took the AI pick: {pick['label']}")


def report():
    for _ in range(15):
        r = call("/api/report")
        if r and r.get("turning_points") is not None:
            break
        time.sleep(2)
    if not r:
        return
    d = r.get("estimated_deaths") or {}
    say("REPORT  " + ("you beat the 2021 playbook" if r.get("beat_playbook") else "the 2021 playbook did better"))
    if d.get("player") is not None:
        say(f"        estimated deaths: about {d['player']} (2021: {d['playbook_2021']} confirmed in Dallas County)")
    sc = r.get("scores") or {}
    you, real = (sc.get("player") or {}).get("cold_person_hours"), (sc.get("playbook_2021") or {}).get("cold_person_hours")
    if you and real:
        say(f"        cold person-hours: {you / 1e6:.1f} million vs {real / 1e6:.1f} million for the 2021 playbook")
    for tp in r.get("turning_points") or []:
        say(f"        turning point: {tp.get('label')}")
    say("        the stress test on 1,000 storms finishes on the report screen in about a minute")


say(f"demo autopilot on {args.server}")
act({"type": "new_game"})
time.sleep(1.5)
say("GET READY  placing the winter plan")
for action, label in PLAN:
    if act(action) is not None:
        say(f"  {label}")
    time.sleep(args.prep_gap)

say(f"START  press GREEN on the box to start the storm (starts by itself in {args.start_wait:.0f} s)")
end = time.time() + args.start_wait
while time.time() < end and state().get("paused", True):
    time.sleep(0.2)
act({"type": "start_storm"})
if args.speed:
    act({"type": "speed", "value": args.speed})
say(f"STORM  started at speed {args.speed or 'default'}")

dialysis_done, held, last_move, last_order = False, False, 0.0, 0
while True:
    s = state()
    if s["phase"] == "over":
        say(f"OVER  {s.get('end_reason', '')}")
        break
    if s.get("event"):
        card(s)
        continue
    if s["order_mw"] > 0 and last_order == 0:
        say(f"ORDER  the grid operator orders {s['order_mw']:,.0f} MW of cuts")
    last_order = s["order_mw"]
    if s.get("hold") and not held:
        held = True
        say(f"HOLD  clock stopped: {s['hold']['short_mw']:,} MW short (the banner stays up a moment for the video)")
        time.sleep(1.5)
    elif not s.get("hold"):
        held = False
    if time.time() - last_move >= ACTION_GAP:
        for action, label in next_moves(s, dialysis_done):
            if "dialysis" in label:
                dialysis_done = True
            after = act(action)
            say(f"  {label}")
            last_move = time.time()
            # stop the plan if the move didn't land or opened a card (a cut that would darken a building asks
            # first), so the restore half of a swap never runs without its cut
            done = after and next((c for c in after["circuits"] if c["id"] == action["circuit"]), {}).get("on") == (action["type"] == "restore")
            if not done or after.get("event"):
                break
    time.sleep(0.05)

report()
