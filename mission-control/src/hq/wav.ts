// Minimal WAV handling for transcription. The dashboard converts every recording
// to 16 kHz mono 16-bit PCM WAV in the browser; this reads that format and splits
// long recordings into clips short enough for audio models (Gemma 4: 30 s max).

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  format: number; // 1 = PCM
  dataOffset: number;
  dataLength: number;
  seconds: number;
}

/** Reads a WAV header, or returns null if the bytes aren't a WAV file. */
export function parseWav(buf: Buffer): WavInfo | null {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return null;
  let pos = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataLength" | "seconds"> | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data" && fmt) {
      const dataLength = Math.min(size, buf.length - body);
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return { ...fmt, dataOffset: body, dataLength, seconds: bytesPerSecond ? dataLength / bytesPerSecond : 0 };
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

function header(info: Pick<WavInfo, "sampleRate" | "channels" | "bitsPerSample">, dataLength: number): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + dataLength, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(info.channels, 22);
  h.writeUInt32LE(info.sampleRate, 24);
  h.writeUInt32LE(info.sampleRate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(info.bitsPerSample, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(dataLength, 40);
  return h;
}

/** Splits PCM WAV into clips of at most `maxSeconds`. Other formats come back whole. */
export function splitWav(buf: Buffer, maxSeconds = 28): Buffer[] {
  const info = parseWav(buf);
  if (!info || info.format !== 1 || info.seconds <= maxSeconds) return [buf];
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  const chunkBytes = Math.floor((info.sampleRate * maxSeconds) * blockAlign / blockAlign) * blockAlign;
  const clips: Buffer[] = [];
  for (let off = 0; off < info.dataLength; off += chunkBytes) {
    const len = Math.min(chunkBytes, info.dataLength - off);
    const start = info.dataOffset + off;
    clips.push(Buffer.concat([header(info, len), buf.subarray(start, start + len)]));
  }
  return clips;
}
