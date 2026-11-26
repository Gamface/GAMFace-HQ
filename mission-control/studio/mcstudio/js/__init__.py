"""Jarvis Studio's video studio (from Gamface/ods-Jarvis, extensions/services/jarvis-studio,
commit afca719), running in Mission Control's studio container on GAMFace16.

video/ is Jarvis Studio's code with small changes (marked "HQ:"). The modules next to it stand
in for what it used on gamface-S8:

  stemdeck  → the studio library (songs and stems)
  images    → ComfyUI on the graphics card (Z-Image Turbo) instead of Lemonade's SD-Turbo
  workflows → speak(): Kokoro in the voice service instead of MOSS-TTS
  audio     → run() as Jarvis Studio's code expects it
  config    → output folders under the studio's data folder
  jobqueue  → a no-op (the studio worker runs the jobs)
  obs       → not available (no live OBS control on Windows; record yourself and upload)

context holds the library, ComfyUI and voice service the worker hands in.
"""
