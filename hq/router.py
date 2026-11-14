"""Picks the right agent for a task when the user chose 'auto'."""
import re

from .agents import AGENTS, roster_text
from .config import Config

KEYWORDS = {
    "coder": r"\b(code|script|function|bug|debug|python|typescript|javascript|api|regex|compile|refactor)\b",
    "security": r"\b(security|vulnerab|audit|harden|firewall|cve|secret|permission)\b",
    "vault": r"\b(note|notes|obsidian|summari[sz]e|checklist|journal|remember)\b",
    "researcher": r"\b(research|compare|explain|why|pros and cons|recommend|analy[sz]e)\b",
    "operator": r"\b(browse|website|download|open the|search the web|run this|execute)\b",
}


def keyword_route(prompt: str) -> str:
    text = prompt.lower()
    for key, pattern in KEYWORDS.items():
        if key in AGENTS and re.search(pattern, text):
            return key
    return "jarvis"


def route(llm, prompt: str) -> tuple[str, str]:
    """Return (agent_key, reason). Falls back to keywords if the model is unavailable."""
    try:
        data = llm.chat_json(Config.fast_model, [
            {"role": "system", "content": (
                "You route tasks to one agent. Agents:\n" + roster_text() +
                "\nPick jarvis for chit-chat, multi-part requests, or anything needing "
                'several specialists. Reply with JSON only: {"agent": "<key>", "reason": "<short>"}'
            )},
            {"role": "user", "content": prompt[:2000]},
        ])
        key = str(data.get("agent", "")).strip().lower()
        if key in AGENTS:
            return key, str(data.get("reason", ""))[:200]
    except Exception:  # noqa: BLE001
        pass
    return keyword_route(prompt), "keyword match"
