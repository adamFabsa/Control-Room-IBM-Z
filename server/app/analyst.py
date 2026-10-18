"""M3 analyst: IBM Granite 3.3 2B on llama.cpp (the llm container) writes short text from a JSON of numbers.

Text with any number that is not in its input is rejected; callers fall back to template sentences.
"""
import asyncio
import json
import logging
import os
import re
import time
import urllib.request

log = logging.getLogger("controlroom.analyst")

LLM_URL = os.environ.get("LLM_URL")
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")

TIP_PROMPT = (
    "You coach operators in a winter-storm power-grid training game. Write one short sentence of advice for "
    "the player's next storm, based on their biggest turning point. If the decision cost cold person-hours or "
    "led to a collapse, advise against repeating it; if it saved them or kept the grid up, advise doing it again. If you use a number, write it exactly "
    "as given. Reply with the sentence only."
)
EVENT_PROMPT = (
    "You write alerts for a power-grid control room during a winter storm. Rewrite this emergency as one or "
    "two short, urgent sentences for the operator. Use only the numbers and facts given. Reply with the "
    "sentences only."
)

_lock = asyncio.Lock()  # llama-server runs one request at a time on 3 cores
_cache = {}  # (prompt, input) -> accepted text
stats = {"requests": 0, "accepted": 0, "rejected": 0, "failed": 0, "seconds": 0.0, "tokens": 0}


def numbers_in(obj):
    """Every number in a JSON-like value, including numbers written inside strings (e.g. "C-13" -> 13)."""
    if isinstance(obj, bool):
        return set()
    if isinstance(obj, (int, float)):
        return {float(obj)}
    if isinstance(obj, str):
        return {float(m.replace(",", "")) for m in NUMBER.findall(obj)}
    values = obj.values() if isinstance(obj, dict) else obj if isinstance(obj, (list, tuple)) else []
    found = set()
    for v in values:
        found |= numbers_in(v)
    return found


def invented_numbers(text, facts):
    """Numbers in text that are not in facts; empty means the text passes. Text carries no minus signs,
    so facts count by absolute value."""
    return numbers_in(text) - {abs(x) for x in numbers_in(facts)}


def _chat(system, user, max_tokens):
    body = json.dumps({"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                       "max_tokens": max_tokens, "temperature": 0}).encode()
    request = urllib.request.Request(f"{LLM_URL}/v1/chat/completions", body,
                                     {"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=180) as r:
        reply = json.load(r)
    text = reply["choices"][0]["message"]["content"].strip()
    if text.startswith("{"):  # the model sometimes answers in JSON; keep its first string
        try:
            text = next(v for v in json.loads(text).values() if isinstance(v, str))
        except Exception:
            pass
    return text.strip().strip('"').strip(), reply.get("timings", {}).get("predicted_n", 0)


async def write(system, facts, max_tokens=120, tries=2, required=(), still_wanted=None, forbidden=()):
    """Granite text that passes the number check and contains every `required` phrase, or None.

    still_wanted() is checked once the model is free, so stale requests (a closed event card) are dropped.
    """
    if not LLM_URL:
        return None
    user = facts if isinstance(facts, str) else json.dumps(facts)
    if (system, user) in _cache:
        return _cache[(system, user)]
    for _ in range(tries):
        async with _lock:
            if still_wanted and not still_wanted():
                return None
            start = time.perf_counter()
            try:
                text, tokens = await asyncio.to_thread(_chat, system, user, max_tokens)
            except Exception as e:
                stats["failed"] += 1
                log.warning("analyst unavailable: %s", e)
                return None
            stats["requests"] += 1
            stats["seconds"] += time.perf_counter() - start
            stats["tokens"] += tokens
        bad = invented_numbers(text, facts)
        missing = [p for p in required if p.lower() not in text.lower()]
        missing += [f"not '{w}'" for w in forbidden if re.search(rf"\b{w}\b", text, re.I)]
        if missing:
            stats["rejected"] += 1
            log.info("rejected analyst text missing %s", missing)
            continue
        if not bad:
            stats["accepted"] += 1
            log.info("accepted analyst text (%d tokens, %.1fs)", tokens, time.perf_counter() - start)
            _cache[(system, user)] = text
            return text
        stats["rejected"] += 1
        log.info("rejected analyst text with numbers not in its input: %s", sorted(bad))
    return None


def _versus(theirs, yours):
    return "more than you" if theirs > yours else "fewer than you" if theirs < yours else "the same as you"


def template_summary(scores, turning_points):
    """The debrief's facts, always computed, never written by the model."""
    you, real, ai = scores["you"], scores["real_2021"], scores["ai_alone"]
    mine = you["cold_person_hours"]
    text = (f"You finished with {mine:,} cold person-hours; the 2021 playbook had {real['cold_person_hours']:,} "
            f"({_versus(real['cold_person_hours'], mine)}) and the AI playing alone had {ai['cold_person_hours']:,} "
            f"({_versus(ai['cold_person_hours'], mine)}). Your longest outage lasted {you['longest_outage_min']:,} "
            f"minutes and critical buildings were dark for {you['critical_dark_min']:,} minutes in total.")
    if you.get("grid_collapsed"):
        text = "The grid collapsed and the game ended early. " + text
    if turning_points:
        text += f" Your biggest turning point was {turning_points[0]['label']}, which {_effect(turning_points[0])}."
    return text


def _effect(tp):
    if tp.get("grid_collapsed_without") and not tp.get("grid_collapsed"):
        return "kept the grid from collapsing"
    if tp.get("grid_collapsed") and not tp.get("grid_collapsed_without"):
        return "led to the grid collapse"
    change = tp["cold_person_hours_change"]
    return f"{'saved' if change > 0 else 'cost'} {abs(change):,} cold person-hours"


REPEAT_WORDS = ("repeat", "again", "continue", "keep doing", "do the same")
AVOID_WORDS = ("avoid", "don't", "do not", "never", "reconsider", "instead")


def tip_forbidden(turning_points):
    """Advice words that would contradict the turning point (a 2B model sometimes praises a costly move)."""
    tp = turning_points[0]
    helped = tp.get("grid_collapsed_without") and not tp.get("grid_collapsed") or (
        tp["cold_person_hours_change"] > 0 and not (tp.get("grid_collapsed") and not tp.get("grid_collapsed_without")))
    return AVOID_WORDS if helped else REPEAT_WORDS


def tip_facts(turning_points):
    return f"Biggest turning point: {turning_points[0]['label']}. It {_effect(turning_points[0])}."


def summary_stats():
    out = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in stats.items()}
    out["tokens_per_sec"] = round(stats["tokens"] / stats["seconds"], 1) if stats["seconds"] else None
    out["model"] = "IBM Granite 3.3 2B Instruct, Q8_0, big-endian GGUF on llama.cpp"
    return out


def event_facts(event):
    options = "; ".join(o["label"] for o in event["options"])
    return f"{event['title']} {event['text']} Options: {options}."
