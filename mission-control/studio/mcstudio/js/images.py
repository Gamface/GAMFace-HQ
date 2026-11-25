"""Pictures for the video studio, made on the graphics card by ComfyUI (Z-Image Turbo, the model
Mission Control's picture tool uses) instead of Lemonade's SD-Turbo on the laptop's CPU."""

from __future__ import annotations

import os
import random
import tempfile
from contextlib import contextmanager
from pathlib import Path

from ..comfy import ComfyError
from . import context

MODEL = os.environ.get("IMAGE_MODEL", "z_image_turbo_bf16.safetensors")
TEXT_ENCODER = os.environ.get("IMAGE_TEXT_ENCODER", "qwen_3_4b.safetensors")
VAE = os.environ.get("IMAGE_VAE", "ae.safetensors")
# Jarvis Studio asks for SD-sized pictures; Z-Image draws at about a megapixel
SIZES = {"512x512": (1024, 1024), "768x768": (1024, 1024), "768x512": (1216, 832), "512x768": (832, 1216)}


@contextmanager
def heavy_job(name: str):
    # HQ: the studio worker already runs one job at a time
    yield


def unload(model: str | None = None) -> None:
    return None


def workflow(prompt: str, width: int, height: int, seed: int, prefix: str) -> dict:
    """The same Z-Image Turbo workflow as tools/images-server.mjs."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": MODEL, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": TEXT_ENCODER, "type": "lumina2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
        "8": {
            "class_type": "KSampler",
            "inputs": {"model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0], "seed": seed, "steps": 8, "cfg": 1, "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1},
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": prefix}},
    }


def generate_png(prompt: str, size: str = "512x512", model: str | None = None, seed: int | None = None, keep_loaded: bool = False) -> bytes:
    """One picture from ComfyUI as PNG bytes."""
    comfy = context.comfy
    if comfy is None:
        raise ComfyError("Pictures are made by ComfyUI on the PC: set COMFY_URL for the studio service")
    w, h = SIZES.get(size, (1024, 1024))
    seed = int(seed) if seed is not None else random.randrange(1, 2**31)
    outputs = comfy.run(workflow(prompt[:1500], w, h, seed, "mission-control/studio-pictures"), timeout=900)
    img = next((o["images"][0] for o in outputs.values() if o.get("images")), None)
    if not img:
        raise ComfyError("ComfyUI made no picture")
    with tempfile.TemporaryDirectory() as tmp:
        return comfy.fetch(img, Path(tmp) / "pic.png").read_bytes()
