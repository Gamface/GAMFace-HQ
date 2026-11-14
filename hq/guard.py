"""Exfiltration guard: redacts secrets from anything that leaves the PC."""
import re

PATTERNS = [
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S)),
    ("anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("openai key", re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{20,}")),
    ("github token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{40,}")),
    ("google key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("aws key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b")),
    ("telegram token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
    ("password assignment", re.compile(r"(?i)\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['\"]?[^\s'\"]{6,}")),
]


def redact(text: str) -> tuple[str, list[str]]:
    """Return (clean_text, list of what was redacted)."""
    found = []
    for label, pattern in PATTERNS:
        if pattern.search(text):
            found.append(label)
            if label == "password assignment":
                text = pattern.sub(lambda m: f"{m.group(1)}=[REDACTED]", text)
            else:
                text = pattern.sub(f"[REDACTED {label}]", text)
    return text, found
