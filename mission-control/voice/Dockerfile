# Mission Control voice service: Kokoro voiceovers (Apache-2.0 model, MIT runtime)
# and faster-whisper word timings (MIT). Built once with internet (about 1 GB of
# packages and models); at runtime it has no internet and sees none of your files.
FROM python:3.12-slim

# espeak-ng: Kokoro's fallback pronunciation for words it doesn't know
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Models, downloaded now while the build has internet
ARG WHISPER_MODEL=base.en
ENV VOICE_MODELS_DIR=/models VOICE_WHISPER_MODEL=${WHISPER_MODEL}
RUN mkdir -p /models/whisper && python - <<'EOF'
import urllib.request
base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
    print("Downloading", name, flush=True)
    urllib.request.urlretrieve(base + name, f"/models/{name}")
EOF
RUN python -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['VOICE_WHISPER_MODEL'], device='cpu', compute_type='int8', download_root='/models/whisper'); print('Whisper ready')"

COPY timing.py server.py test_timing.py ./
# "voice" is a Debian system group, so the user has another name
RUN useradd -m mcvoice && chown -R mcvoice /app
USER mcvoice
# No internet at runtime: never try to download
ENV HF_HUB_OFFLINE=1 PORT=3030 PYTHONUNBUFFERED=1
EXPOSE 3030
CMD ["python", "server.py"]
