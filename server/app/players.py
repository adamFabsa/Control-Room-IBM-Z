"""Headless players for the report comparisons, written only against the state JSON contract.

A player is decide(state) -> list of actions, called once per step.
play_out() runs one to the end of the storm with no clock.
"""


def _meet_order(state, cut_first):
    """Cut circuits in `cut_first` order until the cut covers the order; restore the rest."""
    need = state["order_mw"]
    to_cut = set()
    for c in sorted((c for c in state["circuits"] if not c["protected"]), key=cut_first):
        if need <= 0:
            break
        to_cut.add(c["id"])
        need -= c["mw"]
    actions = []
    for c in state["circuits"]:
        if c["id"] in to_cut and c["on"]:
            actions.append({"type": "cut", "circuit": c["id"]})
        elif c["id"] not in to_cut and not c["on"]:
            actions.append({"type": "restore", "circuit": c["id"]})
    return actions


def playbook_2021(state):
    """Protects only the hospital, then rotates cuts in a fixed order, about an hour each."""
    if state["phase"] == "prepare":
        return [{"type": "buy", "item": "protect", "target": "hospital-1"}, {"type": "start_storm"}]
    order = [c["id"] for c in state["circuits"]]
    return _meet_order(state, lambda c: (
        0 if not c["on"] and c["dark_min"] < 60 else 1 if c["on"] else 2,
        order.index(c["id"]),
    ))


def greedy(state):
    """Each step keeps the warmest unprotected circuits dark and restores the coldest."""
    if state["phase"] == "prepare":
        return [{"type": "start_storm"}]
    return _meet_order(state, lambda c: -c["indoor_f"])


PLAYERS = {"playbook_2021": playbook_2021, "greedy": greedy}


def play_out(game, decide, max_steps=10_000):
    """Plays `game` to the end with `decide`; event cards take the AI pick. Returns (game, history)."""
    history = []
    for _ in range(max_steps):
        state = game.state()
        if state["phase"] not in ("prepare", "storm"):
            break
        if state["event"]:
            options = state["event"]["options"]
            pick = next((o for o in options if o["ai_pick"]), options[0])
            game.apply({"type": "choose", "event": state["event"]["id"], "option": pick["id"]})
            continue
        for action in decide(state):
            game.apply(action)
        if state["phase"] == "prepare":
            if game.state()["phase"] == "prepare":
                game.apply({"type": "start_storm"})
            continue
        game.step()
        after = game.state()
        history.append({"time": after["time"], "people_cold": after["totals"]["people_cold"]})
    return game, history
