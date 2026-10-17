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
    "the player's next storm, based on their biggest turning point. If the decision cost cold person-hours, "
    "advise against repeating it; if it saved them, advise doing it again. If you use a number, write it exactly "
    "as given. Reply with the sentence only."
)
EVENT_PROMPT = (
    "You write alerts for a power-grid control room during a winter storm. Rewrite this emergency as one or "
    "two short, urgent sentences for the operator. Use only numbers and facts in the JSON. No lists."
)

_lock = asyncio.Lock()  # llama-server runs one request at a time on 3 cores
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
    text = reply["choices"][0]["message"]["content"].strip().strip('"').strip()
    return text, reply.get("timings", {}).get("predicted_n", 0)


async def write(system, facts, max_tokens=120, tries=2, required=()):
    """Granite text that passes the number check and contains every `required` phrase, or None."""
    if not LLM_URL:
        return None
    user = facts if isinstance(facts, str) else json.dumps(facts)
    for _ in range(tries):
        async with _lock:
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
        if missing:
            stats["rejected"] += 1
            log.info("rejected analyst text missing %s", missing)
            continue
        if not bad:
            stats["accepted"] += 1
            log.info("accepted analyst text (%d tokens, %.1fs)", tokens, time.perf_counter() - start)
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
    if turning_points:
        top = turning_points[0]
        change = top["cold_person_hours_change"]
        text += (f" Your biggest turning point was {top['label']}, which {'saved' if change > 0 else 'cost'} "
                 f"{abs(change):,} cold person-hours.")
    return text


def tip_facts(turning_points):
    top = turning_points[0]
    change = top["cold_person_hours_change"]
    return (f"Biggest turning point: {top['label']}. It {'saved' if change > 0 else 'cost'} "
            f"{abs(change):,} cold person-hours.")


def summary_stats():
    out = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in stats.items()}
    out["tokens_per_sec"] = round(stats["tokens"] / stats["seconds"], 1) if stats["seconds"] else None
    out["model"] = "IBM Granite 3.3 2B Instruct, Q8_0, big-endian GGUF on llama.cpp"
    return out


def event_facts(event):
    return {"title": event["title"], "text": event["text"], "options": [o["label"] for o in event["options"]]}
