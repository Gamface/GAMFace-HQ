"""run() the way Jarvis Studio's code uses it (returns the CompletedProcess). There are no
computer speakers in a container, so play/stop say so."""

from __future__ import annotations

import subprocess


def run(cmd: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise RuntimeError(f"{cmd[0]} took longer than {timeout} s") from e
    if proc.returncode == -9:
        raise MemoryError("the job ran out of memory and was stopped. Close some apps or containers and try again.")
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {proc.stderr[-800:]}")
    return proc


def play(*_a, **_k):
    raise RuntimeError("Playing on the computer's speakers isn't available in Mission Control: play the file from the Studio page")


def stop(*_a, **_k):
    return None
