// Browser-side audio conversion. Audio models want 16 kHz mono WAV, so every file
// (MP3, M4A, OGG, WebM, FLAC, WAV: anything the browser can play) and every
// recording is decoded and resampled here before upload. No server tools needed.

const RATE = 16000;

function encodeWav(pcm: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Decodes any playable audio and returns 16 kHz mono 16-bit WAV, plus its length. */
export async function toWav16kMono(file: Blob): Promise<{ wav: Blob; seconds: number }> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("This audio format can't be read. Try MP3, M4A, WAV, OGG or WebM.");
  } finally {
    void ctx.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * RATE));
  const off = new OfflineAudioContext(1, frames, RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination); // mixing to one channel averages stereo
  src.start();
  const rendered = await off.startRendering();
  return { wav: encodeWav(rendered.getChannelData(0), RATE), seconds: decoded.duration };
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`;
}
