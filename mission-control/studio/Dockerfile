# Mission Control Studio: songs (ACE-Step in ComfyUI, on the graphics card), stems (Hybrid
# Demucs: on the graphics card through ComfyUI's Mission Control stems node, or here on the
# CPU), practice tracks, karaoke, sheet music (basic-pitch + MuseScore 3) and DAW exports.
# Built once with internet: about 2 GB of packages and the Demucs weights.
FROM python:3.12-slim

# ffmpeg: decoding, mixing, encoding · rubberband: speed and key · MuseScore 3: MIDI to PDF
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg rubberband-cli musescore3 fonts-dejavu-core libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# CPU builds of PyTorch (the graphics card is used through ComfyUI on Windows, not from here)
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch>=2.4,<3" "torchaudio>=2.4,<3"
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps "basic-pitch==0.4.0"

# The Demucs weights (about 320 MB), downloaded now while the build has internet
ENV TORCH_HOME=/models/torch
RUN python -c "import torchaudio; torchaudio.pipelines.HDEMUCS_HIGH_MUSDB_PLUS.get_model(); print('Demucs ready')"

COPY server.py ./
COPY mcstudio ./mcstudio
COPY tests ./tests
RUN useradd -u 1000 -m mcstudio && chown -R mcstudio /models
# Starts as root only to give the data folder (created by Docker) to the studio user, then
# drops to that user (server.py, drop_root)
ENV PORT=3050 PYTHONUNBUFFERED=1 QT_QPA_PLATFORM=offscreen STUDIO_DATA=/data STUDIO_UID=1000
EXPOSE 3050
CMD ["python", "server.py"]
