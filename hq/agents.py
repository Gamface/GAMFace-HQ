"""The agent roster and the prompt each agent sees."""
import json
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Config


@dataclass
class Agent:
    key: str
    name: str
    role: str
    instructions: str
    can_delegate: bool = False


AGENTS: dict[str, Agent] = {
    "jarvis": Agent(
        "jarvis", "Jarvis", "Lead and planner",
        "You lead the team. Answer simple requests yourself. For bigger requests, break the "
        "work up and delegate each piece to the teammate best suited to it, then combine "
        "their results into one clear answer for the user.",
        can_delegate=True,
    ),
    "coder": Agent(
        "coder", "Forge", "Coder (TypeScript / Python)",
        "You write, review and debug code. Return complete, runnable code in fenced blocks "
        "and say briefly how to run it. You cannot execute code yourself.",
        can_delegate=True,
    ),
    "researcher": Agent(
        "researcher", "Atlas", "Researcher and analyst",
        "You research, compare options and explain things. Be precise, say what you are "
        "unsure of, and recommend a clear option when asked.",
        can_delegate=True,
    ),
    "vault": Agent(
        "vault", "Archive", "Notes and knowledge (Obsidian)",
        "You organise knowledge: summaries, notes, checklists and plans. When something is "
        "worth keeping, include a note to save (title + markdown content).",
    ),
    "security": Agent(
        "security", "Sentinel", "Defensive security reviewer",
        "You review plans, code and configurations for security problems and explain "
        "defensive fixes. You never write malware or attack tooling.",
    ),
}

if Config.agenticseek_url:
    AGENTS["operator"] = Agent(
        "operator", "Operator", "Hands-on tools via agenticSeek (web, files, shell)",
        "Tasks sent to you are executed by the agenticSeek backend, which can browse the "
        "web, work with files in its workspace and run code.",
    )


def roster_text(exclude: str | None = None) -> str:
    return "\n".join(
        f"- {a.key}: {a.name}, {a.role}" for a in AGENTS.values() if a.key != exclude
    )


def obsidian_notes(agent_key: str, limit: int = 3000) -> str:
    """Per-agent context from the vault: HQ/shared.md and HQ/agents/<agent>.md."""
    if not Config.obsidian_vault:
        return ""
    base = Path(Config.obsidian_vault) / "HQ"
    parts = []
    for path in (base / "shared.md", base / "agents" / f"{agent_key}.md"):
        if path.is_file():
            parts.append(f"## {path.name}\n{path.read_text(encoding='utf-8', errors='ignore')}")
    return "\n\n".join(parts)[:limit]


def save_obsidian_note(title: str, content: str) -> str | None:
    if not Config.obsidian_vault:
        return None
    safe = "".join(c for c in title if c.isalnum() or c in " -_").strip()[:80] or "note"
    folder = Path(Config.obsidian_vault) / "HQ" / "inbox"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{time.strftime('%Y-%m-%d')} {safe}.md"
    path.write_text(content, encoding="utf-8")
    return str(path)


def build_messages(agent: Agent, task: dict, hive: list[dict], memories: list[str],
                   history: list[dict], child_results: list[dict] | None,
                   allow_delegation: bool) -> list[dict]:
    hive_lines = "\n".join(
        f"[{time.strftime('%H:%M', time.localtime(h['ts']))}] {h['agent']} {h['event']}: {h['summary']}"
        for h in hive
    ) or "(nothing yet)"
    memory_lines = "\n".join(f"- {m}" for m in memories) or "(none)"

    if allow_delegation:
        output_spec = (
            'Respond with JSON only: {"reply": "<your answer or plan for the user>", '
            '"delegate": [{"agent": "<teammate key>", "task": "<self-contained instructions>"}]}. '
            "Use an empty delegate list when you can answer alone. Only delegate to keys in the "
            "team list, and give each teammate everything it needs, since it cannot see this chat."
        )
    else:
        output_spec = 'Respond with JSON only: {"reply": "<your answer>"}.'
    if agent.key == "vault":
        output_spec = output_spec[:-2] + ', "note": {"title": "...", "content": "..."} or null}.'

    system = f"""You are {agent.name}, the {agent.role} on the GAMFace HQ agent team.
{agent.instructions}

YOUR TEAM (you can hand work to them):
{roster_text(exclude=agent.key)}

HIVE MIND (recent activity across the whole team):
{hive_lines}

RELEVANT MEMORIES:
{memory_lines}
{('NOTES FROM THE VAULT:' + chr(10) + obsidian_notes(agent.key)) if obsidian_notes(agent.key) else ''}
Be direct and concise. {output_spec}"""

    messages = [{"role": "system", "content": system}]
    for turn in history:
        messages.append({"role": "user", "content": turn["prompt"]})
        if turn.get("result"):
            messages.append({"role": "assistant", "content": json.dumps({"reply": turn["result"]})})

    user = task["prompt"]
    if child_results:
        results = "\n\n".join(
            f"### {c['agent']} — {c['prompt'][:200]}\n{c['result'] or 'FAILED: ' + (c['error'] or 'no result')}"
            for c in child_results
        )
        user = (f"Original request: {task['prompt']}\n\nYour teammates finished their parts:\n\n"
                f"{results}\n\nCombine this into the final answer for the user.")
    messages.append({"role": "user", "content": user})
    return messages
