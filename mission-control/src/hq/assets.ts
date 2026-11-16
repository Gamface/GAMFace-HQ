// The asset dictionary: your logos, pictures, B-roll clips, music and fonts, each with
// a description, so the Coder uses real assets instead of inventing them. Plus the
// brand (name, colours, font, logo, voice) that Mission Control's templates follow.
//
// Files live in DATA_DIR/assets/files, named by id; index.json describes them. Each
// file is checked by its actual bytes. When a video is made, the assets whose words
// match the request (and the brand logo and font) are sent to the video service.

import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { keywords } from "./skills";
import { sniffImage } from "./uploads";

export type AssetKind = "image" | "video" | "audio" | "font";
export const ASSET_ROLES = ["logo", "picture", "broll", "music", "sound", "font"] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  role: AssetRole;
  ext: string;
  mime: string;
  bytes: number;
  description: string;
  tags: string[];
  seconds?: number;
  width?: number;
  height?: number;
  // Music: found by the voice service
  tempo?: number | null;
  beats?: number[];
  uses: number;
  addedAt: number;
  updatedAt: number;
}

export const MAX_ASSETS = 300;
export const ASSET_LIMITS: Record<AssetKind, number> = {
  image: 10 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
  video: 80 * 1024 * 1024,
  font: 5 * 1024 * 1024,
};
// What one video may carry to the renderer
export const MAX_VIDEO_ASSETS = 6;
const MAX_SEND_BYTES = 120 * 1024 * 1024;

export const ASSET_ID = /^[a-z0-9][a-z0-9-]{0,40}-[a-f0-9]{6}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const AssetInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(400).default(""),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
  role: z.enum(ASSET_ROLES).optional(),
  seconds: z.number().positive().max(36_000).optional(),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});
export const AssetUploadSchema = AssetInputSchema.extend({ data: z.string().min(10) });
export const AssetPatchSchema = AssetInputSchema.partial();

export const BrandSchema = z.object({
  name: z.string().trim().max(60).default(""),
  tagline: z.string().trim().max(120).default(""),
  primary: z.string().regex(HEX).default("#6366f1"),
  secondary: z.string().regex(HEX).default("#0ea5e9"),
  accent: z.string().regex(HEX).default("#facc15"),
  background: z.string().regex(HEX).default("#0b1020"),
  text: z.string().regex(HEX).default("#ffffff"),
  // A system font in the video container, or "brand" for the uploaded font
  font: z
    .string()
    .trim()
    .max(120)
    .regex(/^[\w\s,'"-]+$/)
    .default("Liberation Sans, DejaVu Sans, sans-serif"),
  logo: z.string().regex(ASSET_ID).nullable().default(null),
  fontAsset: z.string().regex(ASSET_ID).nullable().default(null),
  voice: z.string().regex(/^[a-z]{2}_[a-z0-9]+$/).default("af_heart"),
  speed: z.number().min(0.6).max(1.6).default(1),
  captionStyle: z.enum(["karaoke", "pop", "block"]).default("karaoke"),
});
export type Brand = z.infer<typeof BrandSchema>;

// Fonts installed in the video container
export const SYSTEM_FONTS = [
  "Liberation Sans, DejaVu Sans, sans-serif",
  "Liberation Serif, DejaVu Serif, serif",
  "Liberation Mono, DejaVu Sans Mono, monospace",
  "DejaVu Sans, sans-serif",
  "DejaVu Sans Condensed, sans-serif",
];

/** Works out what a file is from its first bytes. */
export function sniffAsset(buf: Buffer): { kind: AssetKind; ext: string; mime: string } | null {
  const img = sniffImage(buf);
  if (img) return { kind: "image", ext: img, mime: img === "jpg" ? "image/jpeg" : `image/${img}` };
  const head = buf.subarray(0, 512).toString("latin1");
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return { kind: "image", ext: "svg", mime: "image/svg+xml" };
  const at = (o: number, s: string) => buf.length >= o + s.length && buf.subarray(o, o + s.length).toString("latin1") === s;
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", ext: "wav", mime: "audio/wav" };
  if (at(0, "ID3") || (buf.length > 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0)) return { kind: "audio", ext: "mp3", mime: "audio/mpeg" };
  if (at(0, "OggS")) return { kind: "audio", ext: "ogg", mime: "audio/ogg" };
  if (at(4, "ftyp")) {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (/^M4A|^M4B/.test(brand)) return { kind: "audio", ext: "m4a", mime: "audio/mp4" };
    if (brand === "qt  ") return { kind: "video", ext: "mov", mime: "video/quicktime" };
    return { kind: "video", ext: "mp4", mime: "video/mp4" };
  }
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return { kind: "video", ext: "webm", mime: "video/webm" };
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x00010000) return { kind: "font", ext: "ttf", mime: "font/ttf" };
  if (at(0, "OTTO")) return { kind: "font", ext: "otf", mime: "font/otf" };
  if (at(0, "wOFF")) return { kind: "font", ext: "woff", mime: "font/woff" };
  if (at(0, "wOF2")) return { kind: "font", ext: "woff2", mime: "font/woff2" };
  return null;
}

const defaultRole = (kind: AssetKind, name: string): AssetRole =>
  kind === "font" ? "font" : kind === "video" ? "broll" : kind === "audio" ? (/\b(sfx|whoosh|click|ding|swoosh|sound)\b/i.test(name) ? "sound" : "music") : /\blogo\b/i.test(name) ? "logo" : "picture";

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "asset";

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").slice(0, 7);

const MUSIC_WORDS = /\b(music|soundtrack|song|track|beat|beats|bgm|background audio|lo-?fi|upbeat)\b/i;

export class Assets {
  private dir: string;
  private filesDir: string;
  private index: Asset[] = [];
  private brandData: Brand;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "assets");
    this.filesDir = path.join(this.dir, "files");
    mkdirSync(this.filesDir, { recursive: true });
    try {
      this.index = JSON.parse(readFileSync(path.join(this.dir, "index.json"), "utf8")) as Asset[];
    } catch {
      this.index = [];
    }
    let brand: unknown = {};
    try {
      brand = JSON.parse(readFileSync(path.join(this.dir, "brand.json"), "utf8"));
    } catch {
      /* first run */
    }
    const parsed = BrandSchema.safeParse(brand);
    this.brandData = parsed.success ? parsed.data : BrandSchema.parse({});
  }

  private write(file: string, data: string) {
    const tmp = path.join(this.dir, `.${file}.${process.pid}.tmp`);
    writeFileSync(tmp, data);
    renameSync(tmp, path.join(this.dir, file));
  }

  private saveIndex() {
    this.write("index.json", JSON.stringify(this.index, null, 1));
  }

  list(): Asset[] {
    return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Asset | undefined {
    return ASSET_ID.test(id) ? this.index.find((a) => a.id === id) : undefined;
  }

  file(id: string): string | null {
    const a = this.get(id);
    if (!a) return null;
    const f = path.join(this.filesDir, `${a.id}.${a.ext}`);
    return existsSync(f) ? f : null;
  }

  bytes(id: string): Buffer | null {
    const f = this.file(id);
    return f ? readFileSync(f) : null;
  }

  /** Adds an asset from base64 (a data: URL is fine). */
  add(input: z.input<typeof AssetUploadSchema>): Asset | { error: string } {
    if (this.index.length >= MAX_ASSETS) return { error: `The asset dictionary is full (${MAX_ASSETS} assets). Delete some first.` };
    const b64 = input.data.replace(/^data:[^;,]*;base64,/, "");
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { error: "Send the file as base64" };
    const buf = Buffer.from(b64, "base64");
    const type = sniffAsset(buf);
    if (!type) return { error: "Supported: PNG, JPEG, GIF, WebP and SVG pictures; MP4, MOV and WebM clips; WAV, MP3, M4A and OGG audio; TTF, OTF and WOFF fonts" };
    if (buf.length > ASSET_LIMITS[type.kind]) return { error: `${type.kind === "image" ? "Pictures" : type.kind === "video" ? "Clips" : type.kind === "audio" ? "Audio files" : "Fonts"} can be at most ${ASSET_LIMITS[type.kind] / 1024 / 1024} MB` };
    const id = `${slug(input.name)}-${crypto.randomBytes(3).toString("hex")}`;
    writeFileSync(path.join(this.filesDir, `${id}.${type.ext}`), buf);
    const now = Date.now();
    const asset: Asset = {
      id,
      name: input.name,
      kind: type.kind,
      role: input.role && this.roleFits(input.role, type.kind) ? input.role : defaultRole(type.kind, input.name),
      ext: type.ext,
      mime: type.mime,
      bytes: buf.length,
      description: input.description ?? "",
      tags: [...new Set((input.tags ?? []).map((t) => t.toLowerCase()))],
      seconds: type.kind === "video" || type.kind === "audio" ? input.seconds : undefined,
      width: input.width,
      height: input.height,
      uses: 0,
      addedAt: now,
      updatedAt: now,
    };
    this.index.push(asset);
    this.saveIndex();
    // The first logo or font becomes the brand's
    if (asset.role === "logo" && !this.brandData.logo) this.setBrand({ ...this.brandData, logo: asset.id });
    if (asset.kind === "font" && !this.brandData.fontAsset) this.setBrand({ ...this.brandData, fontAsset: asset.id });
    return asset;
  }

  private roleFits(role: AssetRole, kind: AssetKind): boolean {
    if (kind === "font") return role === "font";
    if (kind === "image") return role === "logo" || role === "picture";
    if (kind === "video") return role === "broll";
    return role === "music" || role === "sound";
  }

  update(id: string, patch: z.infer<typeof AssetPatchSchema> & { tempo?: number | null; beats?: number[] }): Asset | undefined {
    const a = this.get(id);
    if (!a) return undefined;
    if (patch.name !== undefined) a.name = patch.name;
    if (patch.description !== undefined) a.description = patch.description;
    if (patch.tags !== undefined) a.tags = [...new Set(patch.tags.map((t) => t.toLowerCase()))];
    if (patch.role !== undefined && this.roleFits(patch.role, a.kind)) a.role = patch.role;
    if (patch.seconds !== undefined) a.seconds = patch.seconds;
    if (patch.width !== undefined) a.width = patch.width;
    if (patch.height !== undefined) a.height = patch.height;
    if (patch.tempo !== undefined) a.tempo = patch.tempo;
    if (patch.beats !== undefined) a.beats = patch.beats.slice(0, 4000);
    a.updatedAt = Date.now();
    this.saveIndex();
    return a;
  }

  remove(id: string): boolean {
    const a = this.get(id);
    if (!a) return false;
    rmSync(path.join(this.filesDir, `${a.id}.${a.ext}`), { force: true });
    this.index = this.index.filter((x) => x.id !== id);
    this.saveIndex();
    if (this.brandData.logo === id || this.brandData.fontAsset === id) this.setBrand({ ...this.brandData, logo: this.brandData.logo === id ? null : this.brandData.logo, fontAsset: this.brandData.fontAsset === id ? null : this.brandData.fontAsset });
    return true;
  }

  brand(): Brand {
    return { ...this.brandData };
  }

  /** Saves the brand. Logo and font must be assets of the right kind. */
  setBrand(input: unknown): Brand | { error: string } {
    const parsed = BrandSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    const b = parsed.data;
    if (b.logo && this.get(b.logo)?.kind !== "image") return { error: "The logo must be a picture from the asset dictionary" };
    if (b.fontAsset && this.get(b.fontAsset)?.kind !== "font") return { error: "The brand font must be a font from the asset dictionary" };
    if (b.font === "brand" && !b.fontAsset) return { error: "Upload a font first to use it as the brand font" };
    this.brandData = b;
    this.write("brand.json", JSON.stringify(b, null, 1));
    return this.brand();
  }

  /** Whether a brand has been set up (a name, a logo or changed colours). */
  branded(): boolean {
    const d = BrandSchema.parse({});
    const b = this.brandData;
    return Boolean(b.name || b.logo || b.primary !== d.primary || b.accent !== d.accent || b.background !== d.background);
  }

  /**
   * The assets a video request should get: the ones whose name, description or tags
   * share words with it (or are named in it), plus music when it asks for music.
   * The brand logo and font aren't counted here; render() adds them.
   */
  pick(request: string, max = MAX_VIDEO_ASSETS): Asset[] {
    const words = new Set(keywords(request, 30).map(stem));
    const lower = request.toLowerCase();
    const scored = this.index
      .filter((a) => a.kind !== "font" && a.id !== this.brandData.logo)
      .map((a) => {
        const own = new Set(keywords(`${a.name} ${a.description} ${a.tags.join(" ")} ${a.role}`, 60).map(stem));
        let score = 0;
        for (const w of own) if (words.has(w)) score++;
        if (lower.includes(a.name.toLowerCase()) || lower.includes(a.id)) score += 3;
        if (a.role === "music" && MUSIC_WORDS.test(request)) score += 1;
        if (a.role === "logo" && /\blogos?\b/i.test(request)) score += 1;
        return { a, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || y.a.uses - x.a.uses || y.a.updatedAt - x.a.updatedAt);
    // At most one music track, and keep the upload to the renderer reasonable
    const out: Asset[] = [];
    let bytes = 0;
    for (const { a } of scored) {
      if (out.length >= max) break;
      if (a.role === "music" && out.some((o) => o.role === "music")) continue;
      if (bytes + a.bytes > MAX_SEND_BYTES) continue;
      out.push(a);
      bytes += a.bytes;
    }
    return out;
  }

  recordUse(ids: string[]) {
    let changed = false;
    for (const id of ids) {
      const a = this.get(id);
      if (a) {
        a.uses++;
        changed = true;
      }
    }
    if (changed) this.saveIndex();
  }

  /** The brand logo and font assets, when set. */
  brandAssets(): Asset[] {
    return [this.brandData.logo, this.brandData.fontAsset].map((id) => (id ? this.get(id) : undefined)).filter((a): a is Asset => Boolean(a));
  }
}

/** File name of an asset in the renderer's public folder. */
export const publicName = (a: Asset) => `${a.id}.${a.ext}`;

/** What the Coder is told about the assets and brand a video gets. */
export function assetBlock(picked: Asset[], brand: Brand | null): string {
  const lines: string[] = [];
  if (brand) {
    lines.push(
      `- BRAND${brand.name ? ` "${brand.name}"` : ""}${brand.tagline ? ` (tagline: "${brand.tagline}")` : ""}: colours primary ${brand.primary}, secondary ${brand.secondary}, accent ${brand.accent}, background ${brand.background}, text ${brand.text}. ` +
        "The kit's pieces use them automatically; in your own elements read them from useMC().brand (fields: name, tagline, primary, secondary, accent, background, text, font). " +
        `${brand.logo ? "Show the logo with <Logo />." : brand.name ? "<Logo /> draws the brand name (there's no logo file)." : ""}`,
    );
  }
  const visual = picked.filter((a) => a.kind === "image" || a.kind === "video");
  if (visual.length) {
    lines.push("- ASSETS from the user's asset dictionary (use these real files instead of inventing visuals; refer to them by id):");
    for (const a of visual) {
      const what = a.kind === "video" ? `video clip${a.seconds ? `, ${Math.round(a.seconds)} s` : ""}` : a.role === "logo" ? "logo picture" : "picture";
      lines.push(`  • "${a.id}": ${what}: ${a.name}${a.description ? `. ${a.description}` : ""}${a.tags.length ? ` [${a.tags.join(", ")}]` : ""}`);
    }
    lines.push('  Use them with <Media id="…" /> (fills the frame, slow zoom, clips loop and are muted), in a template\'s media={["…"]}, or <Img src={asset("…")} />.');
  }
  const music = picked.find((a) => a.role === "music");
  if (music) lines.push(`- MUSIC: "${music.name}" plays under the whole video automatically${music.tempo ? ` (${Math.round(music.tempo)} BPM)` : ""}. Don't add audio yourself. useBeat().pulse (1 on each beat, fading to 0) lets visuals hit the beat.`);
  const sounds = picked.filter((a) => a.role === "sound");
  for (const s of sounds) lines.push(`- SOUND EFFECT "${s.id}": ${s.name}. Play it at a moment with <Sequence from={…}><Html5Audio src={asset("${s.id}")} /></Sequence> (import Html5Audio from "remotion").`);
  return lines.join("\n");
}
