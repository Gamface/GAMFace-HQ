"""Mission Control stems node for ComfyUI: splits a song into vocals, drums, bass and other with
Hybrid Demucs (torchaudio's HDEMUCS_HIGH_MUSDB_PLUS) on the graphics card. Mission Control's
studio uses it when it's installed, and splits on the CPU when it isn't.

Install: copy this folder into ComfyUI's custom_nodes folder, e.g.
  %LOCALAPPDATA%\\Comfy-Desktop\\ComfyUI-Installs\\GAMFace\\ComfyUI\\custom_nodes\\mission_control_stems
and restart ComfyUI. The weights (about 320 MB) download on first use.
"""

import torch

import comfy.model_management as mm

import os

SOURCES = ["vocals", "drums", "bass", "other"]
SEGMENT = 10.0
OVERLAP = 0.1
# Safe mode (default): the FFTs (torch.stft/istft) and the LSTM layers, the parts AMD's ROCm on
# Windows most often crashes on, run on the CPU; the convolutions still run on the graphics card.
# MC_STEMS_SAFE=0 runs everything on the graphics card.
SAFE = os.environ.get("MC_STEMS_SAFE", "1") != "0"
_model = None


def make_safe(model, device):
    """Moves the model to `device`, keeping its FFTs and LSTMs on the CPU (see SAFE)."""
    model.to(device)
    if not SAFE or str(device) == "cpu":
        return model
    if not hasattr(model, "_mc_spec"):
        model._mc_spec, model._mc_ispec = model._spec, model._ispec
        model._spec = lambda x: model._mc_spec(x.cpu()).to(x.device)
        model._ispec = lambda z, length=None: model._mc_ispec(z.cpu(), length).to(z.device)
    for m in model.modules():
        if isinstance(m, torch.nn.LSTM):
            m.to("cpu")
            if not hasattr(m, "_mc_forward"):
                m._mc_forward = m.forward

                def forward(x, *args, _m=m, **kwargs):
                    out, state = _m._mc_forward(x.cpu(), *args, **kwargs)
                    return out.to(x.device), state

                m.forward = forward
    return model


def _load():
    global _model
    if _model is None:
        import torchaudio

        _model = torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model().eval()
    return _model


def _separate(model, wav, sr):
    from torchaudio.transforms import Fade

    batch, channels, length = wav.shape
    chunk = int(sr * SEGMENT * (1 + OVERLAP))
    overlap = int(OVERLAP * sr)
    fade = Fade(fade_in_len=0, fade_out_len=overlap, fade_shape="linear")
    start, end = 0, chunk
    out = torch.zeros(batch, len(model.sources), channels, length, device=wav.device)
    pbar = None
    try:
        import comfy.utils

        pbar = comfy.utils.ProgressBar(max(1, length // max(1, chunk - overlap) + 1))
    except Exception:  # noqa: BLE001
        pass
    while start < length - overlap:
        mm.throw_exception_if_processing_interrupted()
        with torch.no_grad():
            got = fade(model(wav[:, :, start:end]))
        out[:, :, :, start:end] += got
        if start == 0:
            fade.fade_in_len = overlap
            start += chunk - overlap
        else:
            start += chunk
        end += chunk
        if end >= length:
            fade.fade_out_len = 0
        if pbar:
            pbar.update(1)
    return out


class MissionControlStemSplit:
    CATEGORY = "audio/Mission Control"
    RETURN_TYPES = ("AUDIO", "AUDIO", "AUDIO", "AUDIO")
    RETURN_NAMES = tuple(SOURCES)
    FUNCTION = "split"
    DESCRIPTION = "Splits a song into vocals, drums, bass and other (Hybrid Demucs) on the graphics card."

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    def split(self, audio):
        import torchaudio.functional as F

        model = _load()
        device = mm.get_torch_device()
        wav = audio["waveform"][:1].float()  # [1, channels, samples]
        sr = int(audio["sample_rate"])
        if wav.shape[1] == 1:
            wav = wav.repeat(1, 2, 1)
        wav = wav[:, :2]
        if sr != 44100:
            wav = F.resample(wav, sr, 44100)
            sr = 44100
        ref = wav.mean(1)
        mean, std = ref.mean(), ref.std() + 1e-8
        try:
            make_safe(model, device)
            out = _separate(model, ((wav - mean) / std).to(device), sr)
        finally:
            model.to("cpu")
            mm.soft_empty_cache()
        out = (out.cpu() * std + mean)[0]
        names = list(model.sources)
        return tuple({"waveform": out[names.index(s)][None].contiguous(), "sample_rate": sr} for s in SOURCES)


NODE_CLASS_MAPPINGS = {"MissionControlStemSplit": MissionControlStemSplit}
NODE_DISPLAY_NAME_MAPPINGS = {"MissionControlStemSplit": "Stem split (Mission Control)"}
