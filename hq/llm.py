"""Minimal Ollama client using only the standard library."""
import json
import re
import urllib.error
import urllib.request

from .config import Config

THINK_RE = re.compile(r"<think>.*?</think>", re.S)


class LLMError(RuntimeError):
    pass


class Ollama:
    def __init__(self, url: str = Config.ollama_url, timeout: int = Config.llm_timeout):
        self.url = url
        self.timeout = timeout

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise LLMError(f"Ollama request failed: {exc}") from exc

    def chat(self, model: str, messages: list[dict], json_mode: bool = False,
             temperature: float = 0.4) -> str:
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
            "think": False,  # qwen3: skip the long reasoning trace
            "options": {"temperature": temperature},
        }
        if json_mode:
            payload["format"] = "json"
        data = self._post("/api/chat", payload)
        text = data.get("message", {}).get("content", "")
        return THINK_RE.sub("", text).strip()

    def chat_json(self, model: str, messages: list[dict]) -> dict:
        text = self.chat(model, messages, json_mode=True, temperature=0.1)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.S)
            if match:
                try:
                    return json.loads(match.group(0))
                except json.JSONDecodeError:
                    pass
        return {}

    def status(self) -> dict:
        try:
            req = urllib.request.Request(self.url + "/api/ps")
            with urllib.request.urlopen(req, timeout=5) as resp:
                ps = json.loads(resp.read())
            models = []
            for m in ps.get("models", []):
                size = m.get("size", 0) or 0
                vram = m.get("size_vram", 0) or 0
                models.append({
                    "name": m.get("name"),
                    "sizeGB": round(size / 1e9, 1),
                    "vramPct": round(100 * vram / size) if size else 0,
                })
            return {"ollama": "up", "models": models}
        except Exception as exc:  # noqa: BLE001 - status must never raise
            return {"ollama": "down", "error": str(exc), "models": []}
