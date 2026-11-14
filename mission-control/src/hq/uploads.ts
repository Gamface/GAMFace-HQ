import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

// Pictures attached to cards. Each is checked by its actual bytes (PNG, JPEG,
// GIF or WebP only), capped in size, and stored under its SHA-256 hash, so an id
// can't point anywhere but the uploads folder and the same picture is stored once.

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_ID = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Works out the image type from its first bytes; null if it isn't a supported picture. */
export function sniffImage(buf: Buffer): "png" | "jpg" | "gif" | "webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export class Uploads {
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "uploads");
    if (dataDir !== ":memory:") mkdirSync(this.dir, { recursive: true });
  }

  /** Saves a picture from base64 (a data: URL is fine). Returns its id, or an error message. */
  save(data: string): { id: string; type: string; bytes: number } | { error: string } {
    const b64 = data.replace(/^data:[^;,]*;base64,/, "");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: "Send the picture as base64" };
    const buf = Buffer.from(b64, "base64");
    if (!buf.length) return { error: "The picture is empty" };
    if (buf.length > MAX_IMAGE_BYTES) return { error: `Pictures can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
    const ext = sniffImage(buf);
    if (!ext) return { error: "Only PNG, JPEG, GIF and WebP pictures are supported" };
    const id = `${createHash("sha256").update(buf).digest("hex")}.${ext}`;
    const file = path.join(this.dir, id);
    if (!existsSync(file)) writeFileSync(file, buf);
    return { id, type: TYPES[ext], bytes: buf.length };
  }

  exists(id: string): boolean {
    return IMAGE_ID.test(id) && existsSync(path.join(this.dir, id));
  }

  /** The picture's bytes and type, or null for an unknown or malformed id. */
  read(id: string): { buf: Buffer; type: string } | null {
    if (!this.exists(id)) return null;
    return { buf: readFileSync(path.join(this.dir, id)), type: TYPES[id.split(".")[1]] };
  }

  /** Base64 for sending to a model. */
  base64(id: string): string | null {
    const r = this.read(id);
    return r ? r.buf.toString("base64") : null;
  }
}
