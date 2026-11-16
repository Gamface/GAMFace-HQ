# Mission Control video service: real Remotion, rendering scenes the Coder writes.
# Built once (with internet); at runtime the container has no internet and no
# access to your files or keys: it only receives scene code and returns MP4s.
FROM node:22-bookworm-slim

# Libraries Chrome Headless Shell needs, plus fonts so text and emoji render
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 \
      libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 \
      libpango-1.0-0 libcairo2 libcups2 libdrm2 libxshmfence1 \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
# Download Remotion's Chrome now, while the build has internet
RUN node -e "import('@remotion/renderer').then(r => r.ensureBrowser()).then(() => console.log('Chrome Headless Shell ready'))"
COPY server.mjs ./

# Run as an ordinary user, not root
RUN useradd -m render && mkdir -p /app/jobs && chown -R render /app
USER render
ENV PORT=3020
EXPOSE 3020
CMD ["node", "server.mjs"]
