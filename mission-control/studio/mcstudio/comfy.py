"""ComfyUI on Windows, where the graphics card is: ACE-Step 1.5 songs and (with the Mission
Control stems node installed) stem splitting. The studio container reaches it through Docker
Desktop as host.docker.internal:8188."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Callable

STEM_NODE = "MissionControlStemSplit"
STEMS = ["vocals", "drums", "bass", "other"]

KEYS = [f"{root} {q}" for q in ("major", "minor") for root in ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"]]
LANGUAGES = {"ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "he", "hi", "hr", "ht", "hu", "id", "is", "it", "ja", "ko", "la", "lt", "ms", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sa", "sk", "sr", "sv", "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "yue", "zh", "unknown"}
ACE_DOWNLOAD = "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/checkpoints/ace_step_1.5_turbo_aio.safetensors"


class ComfyError(RuntimeError):
    pass


NOT_RUNNING = 'ComfyUI isn\'t running on the PC. Start it with  Start-ScheduledTask "Mission Control ComfyUI"  in PowerShell (see README-HQ, Pictures).'


class Comfy:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def _get(self, path: str, timeout: float = 15):
        try:
            with urllib.request.urlopen(f"{self.base}{path}", timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise ComfyError(f"ComfyUI answered {e.code} for {path}") from e
        except (urllib.error.URLError, OSError) as e:
            raise ComfyError(NOT_RUNNING) from e

    def _post(self, path: str, data: bytes, ctype: str, timeout: float = 60):
        req = urllib.request.Request(f"{self.base}{path}", data=data, headers={"Content-Type": ctype}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                err = json.loads(body)
                detail = err.get("error", {}).get("message") or body
                nodes = err.get("node_errors") or {}
                for n in nodes.values():
                    for x in n.get("errors", []):
                        detail += f" ({x.get('message')}: {x.get('details')})"
            except (json.JSONDecodeError, AttributeError):
                detail = body
            raise ComfyError(f"ComfyUI refused the job: {detail[:500]}") from e
        except (urllib.error.URLError, OSError) as e:
            raise ComfyError(NOT_RUNNING) from e

    def running(self) -> bool:
        try:
            self._get("/system_stats", timeout=3)
            return True
        except ComfyError:
            return False

    def node_info(self, node: str) -> dict | None:
        """The node's definition, or None when this ComfyUI doesn't have it."""
        try:
            info = json.loads(self._get(f"/object_info/{urllib.parse.quote(node)}", timeout=10))
        except (ComfyError, json.JSONDecodeError):
            return None
        return info.get(node)

    def checkpoints(self) -> list[str]:
        info = self.node_info("CheckpointLoaderSimple") or {}
        try:
            return list(info["input"]["required"]["ckpt_name"][0])
        except (KeyError, IndexError, TypeError):
            return []

    def options(self, node: str, field: str) -> list[str]:
        """The files a loader node offers for one of its inputs."""
        info = self.node_info(node) or {}
        try:
            return list(info["input"]["required"][field][0])
        except (KeyError, IndexError, TypeError):
            return []

    def ace_models(self) -> dict | None:
        """ACE-Step 1.5 as installed in ComfyUI: the all-in-one checkpoint, or the split files
        (diffusion model, two Qwen text encoders, VAE) the split template downloads. Turbo first."""
        turbo_first = lambda xs: sorted(xs, key=lambda c: (0 if "turbo" in c.lower() else 1, c))  # noqa: E731
        aio = turbo_first([c for c in self.checkpoints() if "ace_step" in c.lower() and "1.5" in c])
        if aio:
            return {"mode": "aio", "ckpt": aio[0], "label": aio[0]}
        unet = turbo_first([u for u in self.options("UNETLoader", "unet_name") if "acestep" in u.lower().replace("_", "") and ("1.5" in u or "15" in u)])
        encoders = [t for t in self.options("DualCLIPLoader", "clip_name1") if "ace15" in t.lower()]
        small = next((t for t in encoders if "0.6b" in t.lower()), None)
        large = next((t for t in encoders if "1.7b" in t.lower() or "4b" in t.lower()), None)
        vae = next((v for v in self.options("VAELoader", "vae_name") if "ace" in v.lower() and "1.5" in v), None)
        if unet and small and large and vae:
            return {"mode": "split", "unet": unet[0], "clip1": small, "clip2": large, "vae": vae, "label": unet[0]}
        return None

    def ace_checkpoint(self) -> str | None:
        """A name for the ACE-Step 1.5 model ComfyUI has, if any."""
        m = self.ace_models()
        return m["label"] if m else None

    def upload(self, path: Path, subfolder: str = "mission-control") -> str:
        """Puts a file in ComfyUI's input folder; returns the name LoadAudio takes."""
        boundary = uuid.uuid4().hex
        parts = []
        for name, value in (("type", "input"), ("subfolder", subfolder), ("overwrite", "true")):
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        parts.append(path.read_bytes())
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        out = json.loads(self._post("/upload/image", b"".join(parts), f"multipart/form-data; boundary={boundary}", timeout=300))
        return f"{out.get('subfolder')}/{out['name']}" if out.get("subfolder") else out["name"]

    def run(self, workflow: dict, timeout: float = 1800, cancelled: Callable[[], bool] | None = None, progress: Callable[[str], None] | None = None) -> dict:
        """Queues a workflow and waits for it. Returns the outputs by node id."""
        client = uuid.uuid4().hex
        out = json.loads(self._post("/prompt", json.dumps({"prompt": workflow, "client_id": client}).encode(), "application/json"))
        pid = out["prompt_id"]
        started = time.time()
        while True:
            if cancelled and cancelled():
                try:
                    self._post("/interrupt", json.dumps({"prompt_id": pid}).encode(), "application/json")
                    self._post("/queue", json.dumps({"delete": [pid]}).encode(), "application/json")
                except ComfyError:
                    pass
                raise InterruptedError("Cancelled")
            hist = json.loads(self._get(f"/history/{pid}", timeout=15) or b"{}")
            entry = hist.get(pid)
            if entry:
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    for kind, m in status.get("messages", []):
                        if kind == "execution_error":
                            raise ComfyError(f"{m.get('node_type', 'A step')} failed in ComfyUI: {str(m.get('exception_message', '')).strip().splitlines()[0][:300]}")
                    raise ComfyError("ComfyUI reported an error")
                if status.get("completed", True):
                    return entry.get("outputs", {})
            if time.time() - started > timeout:
                raise ComfyError(f"ComfyUI didn't finish within {timeout / 60:.0f} minutes")
            if progress:
                progress(f"working on the graphics card ({int(time.time() - started)} s)")
            time.sleep(2)

    def fetch(self, file: dict, dst: Path) -> Path:
        q = urllib.parse.urlencode({"filename": file["filename"], "subfolder": file.get("subfolder", ""), "type": file.get("type", "output")})
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(self._get(f"/view?{q}", timeout=120))
        return dst


def audio_files(outputs: dict) -> dict[str, list[dict]]:
    """The audio each output node saved, by node id."""
    return {nid: o.get("audio", []) for nid, o in outputs.items() if o.get("audio")}


def song_workflow(models: str | dict, tags: str, lyrics: str, seconds: float, bpm: int, key: str, timesig: str, language: str, seed: int, prefix: str, steps: int = 8, source: str | None = None, denoise: float = 1.0) -> dict:
    """ComfyUI's ACE-Step 1.5 templates in API form: audio_ace_step_1_5_checkpoint (one file) or
    audio_ace_step_1_5_split (model, text encoders and VAE). `models` is ace_models() or a checkpoint name.
    With `source` (a file in ComfyUI's input folder) it starts from that audio instead of silence:
    `denoise` says how much is rewritten (0.5 keeps the arrangement and timing, 1.0 ignores it)."""
    if isinstance(models, str):
        models = {"mode": "aio", "ckpt": models}
    if models["mode"] == "split":
        loaders = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": models["unet"], "weight_dtype": "default"}},
            "1b": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": models["clip1"], "clip_name2": models["clip2"], "type": "ace", "device": "default"}},
            "1c": {"class_type": "VAELoader", "inputs": {"vae_name": models["vae"]}},
        }
        model, clip, vae = ["1", 0], ["1b", 0], ["1c", 0]
    else:
        loaders = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": models["ckpt"]}}}
        model, clip, vae = ["1", 0], ["1", 1], ["1", 2]
    if key not in KEYS:
        key = "C major"
    if language not in LANGUAGES:
        language = "en"
    if timesig not in ("2", "3", "4", "6"):
        timesig = "4"
    return {
        **loaders,
        "2": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": model, "shift": 3}},
        "3": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {
                "clip": clip, "tags": tags, "lyrics": lyrics or "[Instrumental]", "seed": seed, "bpm": bpm, "duration": seconds,
                "timesignature": timesig, "language": language, "keyscale": key, "generate_audio_codes": True,
                "cfg_scale": 2.0, "temperature": 0.85, "top_p": 0.9, "top_k": 0, "min_p": 0.0,
            },
        },
        "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
        **(
            {
                "5a": {"class_type": "LoadAudio", "inputs": {"audio": source}},
                "5": {"class_type": "VAEEncodeAudio", "inputs": {"audio": ["5a", 0], "vae": vae}},
            }
            if source
            else {"5": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": seconds, "batch_size": 1}}}
        ),
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0], "seed": seed, "steps": steps, "cfg": 1,
                "sampler_name": "euler", "scheduler": "simple", "denoise": round(max(0.05, min(1.0, denoise)), 2) if source else 1,
            },
        },
        "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": vae}},
        "8": {"class_type": "SaveAudio", "inputs": {"audio": ["7", 0], "filename_prefix": prefix}},
    }


def split_workflow(input_name: str, prefix: str) -> dict:
    """LoadAudio → Mission Control stems node (Hybrid Demucs on the graphics card) → one file per stem."""
    wf: dict = {
        "1": {"class_type": "LoadAudio", "inputs": {"audio": input_name}},
        "2": {"class_type": STEM_NODE, "inputs": {"audio": ["1", 0]}},
    }
    for i, name in enumerate(STEMS):
        wf[str(10 + i)] = {"class_type": "SaveAudio", "inputs": {"audio": ["2", i], "filename_prefix": f"{prefix}/{name}"}}
    return wf


UPSCALE_DOWNLOAD = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"


def upscale_workflow(input_name: str, model: str, prefix: str) -> dict:
    """LoadImage → an upscale model (Real-ESRGAN 4x) → SaveImage. ComfyUI's own nodes."""
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": input_name}},
        "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}},
        "3": {"class_type": "ImageUpscaleWithModel", "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["3", 0], "filename_prefix": prefix}},
    }


def edit_workflow(image_name: str, mask_name: str, prompt: str, seed: int, strength: float, prefix: str, unet: str, clip: str, vae: str, steps: int = 8) -> dict:
    """Repaints the white part of the mask with Z-Image Turbo (the picture model Mission Control
    already uses): the picture is encoded, only the masked part of it is noised and redrawn."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip, "type": "lumina2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "8": {"class_type": "LoadImageMask", "inputs": {"image": mask_name, "channel": "red"}},
        "9": {"class_type": "VAEEncode", "inputs": {"pixels": ["7", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["9", 0], "mask": ["8", 0]}},
        "11": {
            "class_type": "KSampler",
            "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["10", 0], "seed": seed, "steps": steps, "cfg": 1, "sampler_name": "res_multistep", "scheduler": "simple", "denoise": round(max(0.3, min(1.0, strength)), 2)},
        },
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
    }


def image_files(outputs: dict) -> list[dict]:
    return [img for o in outputs.values() for img in o.get("images", [])]
