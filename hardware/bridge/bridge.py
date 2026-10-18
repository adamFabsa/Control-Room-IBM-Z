"""Grid Status Box bridge: Pico (USB serial) <-> game server (WebSocket).

  pip install pyserial websockets
  python bridge.py --fake                               # no server: print actions, cycle the LEDs
  python bridge.py --server ws://<vm-ip>:8000/ws        # the real game

Pico -> laptop words: PAUSE, SPEED, CONFIRM. Laptop -> Pico words: GREEN, YELLOW, RED, BEEP, TONE.
Never blocks the game: serial timeout 0, WebSocket recv timeout 20 ms, reconnects every 2 s.
"""
import argparse
import json
import time

import serial
from serial.tools import list_ports
from websockets.sync.client import connect

PICO_VID = 0x2E8A
RETRY_S = 2.0

parser = argparse.ArgumentParser()
parser.add_argument("--server", default="ws://localhost:8000/ws")
parser.add_argument("--port", help="serial port, e.g. COM5 or /dev/ttyACM0 (default: find the Pico)")
parser.add_argument("--fake", action="store_true", help="no server: print actions, cycle LEDs, fake events")
args = parser.parse_args()

ser = None
ws = None
next_serial_try = 0.0
next_ws_try = 0.0
buf = b""
state = None        # last state JSON from the server (or the fake one)
light = None        # LED word last sent to the Pico
last_event = None   # id of the last event card seen

# Fake mode: a pretend game that changes every 3 s and opens a card every 12 s.
fake_started = time.monotonic()
fake_state = {"paused": False, "speed": 1, "order_mw": 0, "cut_mw": 0, "event": None}
fake_events = 0
fake_phases = [(0, 0), (1000, 1000), (1000, 600)]   # green, yellow, red

print("bridge:", "fake mode" if args.fake else args.server)

while True:
    now = time.monotonic()

    # Connect to the Pico (found by its USB vendor id) every 2 s until it answers.
    if ser is None and now >= next_serial_try:
        next_serial_try = now + RETRY_S
        port = args.port
        if port is None:
            for p in list_ports.comports():
                if p.vid == PICO_VID:
                    port = p.device
                    break
        if port is None:
            print("pico: not found, retrying")
        else:
            try:
                ser = serial.Serial(port, 115200, timeout=0, write_timeout=0.05)
                buf = b""
                light = None          # resend the LED after a reconnect
                print("pico: connected on", port)
            except Exception as e:
                ser = None
                print("pico:", e)

    # Connect to the game server every 2 s until it answers.
    if not args.fake and ws is None and now >= next_ws_try:
        next_ws_try = now + RETRY_S
        try:
            ws = connect(args.server, open_timeout=1)
            print("server: connected")
        except Exception as e:
            ws = None
            print("server: not reachable,", e)

    # Words from the Pico.
    words = []
    if ser is not None:
        try:
            buf += ser.read(256)
        except Exception as e:
            print("pico: lost,", e)
            ser.close()
            ser = None
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            word = line.decode(errors="ignore").strip().upper()
            if word:
                words.append(word)

    # State from the server, or from the fake game.
    if ws is not None:
        try:
            msg = json.loads(ws.recv(timeout=0.02))
            if isinstance(msg, dict) and "order_mw" in msg:
                state = msg
        except TimeoutError:
            pass
        except Exception as e:
            print("server: lost,", e)
            ws = None
    else:
        time.sleep(0.02)
    if args.fake:
        elapsed = now - fake_started
        order, cut = fake_phases[int(elapsed // 3) % 3]
        fake_state["order_mw"] = order
        fake_state["cut_mw"] = cut
        if int(elapsed // 12) > fake_events:
            fake_events = int(elapsed // 12)
            fake_state["event"] = {"id": f"ev-{fake_events}", "title": "Fake event",
                                   "options": [{"id": "gen", "ai_pick": True}, {"id": "dark", "ai_pick": False}]}
            print("fake: event", fake_state["event"]["id"], "opened")
        state = fake_state

    # Button words -> game actions.
    for word in words:
        action = None
        if word == "PAUSE":
            action = {"type": "play"} if state and state.get("paused") else {"type": "pause"}
        elif word == "SPEED":
            speed = state.get("speed", 1) if state else 1
            action = {"type": "speed", "value": speed % 5 + 1}
        elif word == "CONFIRM":
            event = state.get("event") if state else None
            if event and event.get("options"):
                pick = event["options"][0]
                for option in event["options"]:
                    if option.get("ai_pick"):
                        pick = option
                        break
                action = {"type": "choose", "event": event["id"], "option": pick["id"]}
            else:
                print("button: CONFIRM, but no event card is open")
        else:
            print("pico: unknown word", word)
        if action is None:
            continue
        print("button:", word, "->", json.dumps(action))
        if ws is not None:
            try:
                ws.send(json.dumps(action))
            except Exception as e:
                print("server: lost,", e)
                ws = None
        if args.fake:
            if action["type"] == "pause":
                fake_state["paused"] = True
            elif action["type"] == "play":
                fake_state["paused"] = False
            elif action["type"] == "speed":
                fake_state["speed"] = action["value"]
            elif action["type"] == "choose":
                fake_state["event"] = None

    # Game state -> LEDs and buzzer, sent only on change.
    if state is not None and ser is not None:
        order = state.get("order_mw") or 0
        cut = state.get("cut_mw") or 0
        # the same tolerance as the game's order bar: within 5% counts as met
        if order <= 0:
            color = "GREEN"
        elif cut >= order * 0.95:
            color = "YELLOW"
        else:
            color = "RED"
        out = b""
        if color != light:
            out += (color + "\n").encode()
            if color == "RED":
                out += b"TONE\n"
            print("leds:", color, "(order", order, "MW, cut", cut, "MW)")
            light = color
        event = state.get("event")
        event_id = event.get("id") if event else None
        if event_id and event_id != last_event:
            out += b"BEEP\n"
            print("buzzer: BEEP for", event_id)
        last_event = event_id
        if out:
            try:
                ser.write(out)
            except Exception as e:
                print("pico: lost,", e)
                ser.close()
                ser = None
