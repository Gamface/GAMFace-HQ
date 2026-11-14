"""Settings, read from environment variables or a .env file in the project root."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(ROOT / ".env")


def _list(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


class Config:
    host = os.environ.get("HQ_HOST", "127.0.0.1")
    port = int(os.environ.get("HQ_PORT", "3030"))
    db_path = Path(os.environ.get("HQ_DB", str(ROOT / "data" / "hq.sqlite3")))

    ollama_url = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    model = os.environ.get("HQ_MODEL", "qwen3:14b")
    # Small model for routing and memory extraction; falls back to the main model.
    fast_model = os.environ.get("HQ_FAST_MODEL", "") or model
    llm_timeout = int(os.environ.get("HQ_LLM_TIMEOUT", "300"))

    telegram_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    telegram_allowed = set(_list("TELEGRAM_ALLOWED_CHAT_IDS"))

    obsidian_vault = os.environ.get("OBSIDIAN_VAULT", "")

    # Optional bridge to the agenticSeek backend for tasks that need real tools.
    agenticseek_url = os.environ.get("AGENTICSEEK_URL", "").rstrip("/")
    agenticseek_token = os.environ.get("AGENTICSEEK_TOKEN", "")

    memory_interval_min = int(os.environ.get("HQ_MEMORY_INTERVAL_MIN", "30"))
    max_delegation_depth = int(os.environ.get("HQ_MAX_DELEGATION_DEPTH", "2"))
