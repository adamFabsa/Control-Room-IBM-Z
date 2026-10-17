"""Run the stormgame engine from the command line.

  python run_cli.py                       # playbook_2021 vs greedy on Uri, with timing
  python run_cli.py --storm generated --seed 7
  python run_cli.py --player greedy --state   # print the final state JSON
  python run_cli.py --interactive         # type moves yourself
"""

import argparse
import json
import time

from stormgame import Game, play


def headless(args):
    players = [args.player] if args.player else ["playbook_2021", "greedy"]
    for name in players:
        t0 = time.perf_counter()
        g = play(name, storm=args.storm, seed=args.seed)
        secs = time.perf_counter() - t0
        again = play(name, storm=args.storm, seed=args.seed).score()
        print(f"{name:14s} {secs:5.2f}s  same score on rerun: {again == g.score()}  ({g.end_reason})")
        print("  ", json.dumps(g.score()))
        if args.state:
            print(json.dumps(g.state(), indent=2))
    if g.storm.note:
        print("storm note:", g.storm.note)


HELP = """commands:
  buy <item> [target]     protect generator warming_center keep_gas conservation repair_crews smart_switch
  start                   start the storm
  cut <id> / restore <id>
  emergency <item> <target>
  choose <option>         answer the open event card
  step [n]                advance n steps of 5 minutes (default 1)
  hours <n>               advance n game hours
  state / score / json {...} / quit"""


def show(g):
    s = g.state()
    print(f"{s['time']}  {s['phase']}  outside {s['outside_f']}°F  order {s['order_mw']} MW  "
          f"cut {s['cut_mw']} MW  points {s['points']}  cold {s['totals']['people_cold']:,}  "
          f"cph {s['totals']['cold_person_hours']:,}")
    dark = [f"{c['id']}({c['indoor_f']}°F,{c['dark_min']}m)" for c in s["circuits"] if not c["on"]]
    if dark:
        print("  dark:", " ".join(dark))
    print("  tip:", s["copilot"]["tip"])
    if s["event"]:
        e = s["event"]
        print(f"  EVENT {e['id']}: {e['title']} {e['text']}")
        for o in e["options"]:
            print(f"    {o['id']:8s} {o['label']}{'  <- AI pick' if o['ai_pick'] else ''}")


def interactive(args):
    g = Game(storm=args.storm, seed=args.seed)
    print(HELP)
    show(g)
    while True:
        try:
            parts = input("> ").split(maxsplit=1)
        except EOFError:
            return
        if not parts:
            continue
        cmd, rest = parts[0], (parts[1] if len(parts) > 1 else "")
        words = rest.split()
        if cmd in ("quit", "q"):
            return
        if cmd in ("step", "hours"):
            n = int(words[0]) if words else 1
            for _ in range(n * (12 if cmd == "hours" else 1)):
                g.step()
                if g.event or g.phase != "storm":
                    break
        elif cmd == "state":
            print(json.dumps(g.state(), indent=2))
            continue
        elif cmd == "score":
            print(json.dumps(g.score(), indent=2))
            continue
        else:
            if cmd == "json":
                action = json.loads(rest)
            elif cmd == "start":
                action = {"type": "start_storm"}
            elif cmd in ("buy", "emergency"):
                action = {"type": cmd, "item": words[0], "target": words[1] if len(words) > 1 else None}
            elif cmd in ("cut", "restore"):
                action = {"type": cmd, "circuit": words[0]}
            elif cmd == "choose":
                action = {"type": "choose", "event": g.event and g.event["id"], "option": words[0]}
            else:
                print(HELP)
                continue
            r = g.try_apply(action)
            if not r["ok"]:
                print("  !", r["error"])
        show(g)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--storm", default="uri2021", choices=["uri2021", "generated", "test"])
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--player", choices=["playbook_2021", "greedy"])
    ap.add_argument("--state", action="store_true", help="print the final state JSON")
    ap.add_argument("--interactive", action="store_true")
    args = ap.parse_args()
    interactive(args) if args.interactive else headless(args)


if __name__ == "__main__":
    main()
