// Mission Control's Remotion kit: captions, brand pieces and ready-made templates.
// Every scene can `import { … } from "./mc"`. The video service wraps each scene with
// withMC(), which adds the voiceover, music and (when asked) captions automatically.

import React, { createContext, useContext, useEffect, useState } from "react";
import * as R from "remotion";
import {
  AbsoluteFill,
  Easing,
  Img,
  Loop,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// ------------------------------------------------------------------ props

export type Word = { text: string; start: number; end: number };
export type Brand = {
  name: string;
  tagline: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  font: string;
  logo: string | null;
};
export type AssetInfo = { file: string; kind: "image" | "video" | "audio" | "font"; name: string; seconds?: number };
export type Music = { file: string; beats: number[]; tempo: number | null; volume?: number };
export type CaptionStyle = "karaoke" | "pop" | "block";
export type MCProps = {
  images: string[];
  words: Word[];
  audio: string | null;
  music: Music | null;
  assets: Record<string, AssetInfo>;
  brand: Brand;
  captions: { auto: boolean; style: CaptionStyle; position: "bottom" | "center" | "top" };
};

export const DEFAULT_BRAND: Brand = {
  name: "",
  tagline: "",
  primary: "#6366f1",
  secondary: "#0ea5e9",
  accent: "#facc15",
  background: "#0b1020",
  text: "#ffffff",
  font: "Liberation Sans, DejaVu Sans, sans-serif",
  logo: null,
};

export const DEFAULT_PROPS: MCProps = {
  images: [],
  words: [],
  audio: null,
  music: null,
  assets: {},
  brand: DEFAULT_BRAND,
  captions: { auto: false, style: "karaoke", position: "bottom" },
};

function normalize(p: Partial<MCProps> | undefined): MCProps {
  const words = Array.isArray(p?.words) ? p!.words.filter((w) => w && typeof w.text === "string" && Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
  return {
    images: Array.isArray(p?.images) ? p!.images : [],
    words,
    audio: typeof p?.audio === "string" ? p.audio : null,
    music: p?.music && typeof p.music.file === "string" ? { ...p.music, beats: Array.isArray(p.music.beats) ? p.music.beats : [] } : null,
    assets: p?.assets && typeof p.assets === "object" ? p.assets : {},
    brand: { ...DEFAULT_BRAND, ...(p?.brand ?? {}) },
    captions: { ...DEFAULT_PROPS.captions, ...(p?.captions ?? {}) },
  };
}

type Ctx = MCProps & { frame: number };
const MC = createContext<Ctx>({ ...DEFAULT_PROPS, frame: 0 });
// The same props, for helpers called outside components (asset("logo"))
let current: MCProps = DEFAULT_PROPS;

/** Everything Mission Control passed in: words, brand, assets, music. */
export const useMC = (): Ctx => useContext(MC);
/** The frame counted from the start of the video, even inside a <Sequence>. */
export const useVideoFrame = (): number => useContext(MC).frame;
export const brand = (): Brand => current.brand;

/** The URL of an asset from the asset dictionary, by its id. */
export function asset(id: string): string {
  const a = current.assets[id];
  if (!a) {
    const ids = Object.keys(current.assets);
    throw new Error(`No asset "${id}" was given to this video. Available: ${ids.length ? ids.join(", ") : "none"}`);
  }
  return staticFile(a.file);
}
export const hasAsset = (id: string): boolean => Boolean(current.assets[id]);

// Remotion renamed <Audio> to <Html5Audio>; use whichever this version has
// (looked up at run time so the bundler doesn't warn about the missing one)
const AUDIO_NAMES = ["Html5Audio", "Audio"];
const AudioTag: React.FC<any> | undefined = AUDIO_NAMES.map((n) => (R as Record<string, any>)[n]).find(Boolean);

const fontId = (file: string) => `mc-font-${file.replace(/[^a-z0-9]/gi, "")}`;

/** Loads uploaded brand fonts before the first frame is captured. */
const FontLoader: React.FC<{ files: string[] }> = ({ files }) => {
  const [handle] = useState(() => (files.length ? delayRender("Loading brand fonts") : null));
  useEffect(() => {
    if (handle === null) return;
    Promise.all(
      files.map((f) =>
        new FontFace(fontId(f), `url(${staticFile(f)})`)
          .load()
          .then((face) => {
            (document.fonts as any).add(face);
          })
          .catch((e) => console.error(`Font ${f} didn't load`, e)),
      ),
    ).finally(() => continueRender(handle));
  }, [handle, files]);
  return null;
};

/** Wraps a scene: context, brand fonts, voiceover, music bed and automatic captions. */
export function withMC<P extends object>(Scene: React.ComponentType<P>): React.FC<P & Partial<MCProps>> {
  const Wrapped: React.FC<P & Partial<MCProps>> = (raw) => {
    const frame = useCurrentFrame();
    const { fps, durationInFrames } = useVideoConfig();
    const p = normalize(raw);
    current = p;
    const fonts = Object.values(p.assets).filter((a) => a.kind === "font").map((a) => a.file);
    const brandFont = Object.entries(p.assets).find(([, a]) => a.kind === "font");
    const value: Ctx = {
      ...p,
      frame,
      brand: brandFont && p.brand.font === "brand" ? { ...p.brand, font: `${fontId(brandFont[1].file)}, sans-serif` } : p.brand,
    };
    current = value;
    const musicLevel = p.music?.volume ?? (p.audio ? 0.14 : 0.55);
    const fade = (f: number) => interpolate(f, [0, fps, Math.max(fps + 1, durationInFrames - fps * 1.5), durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    return (
      <MC.Provider value={value}>
        <FontLoader files={fonts} />
        <AbsoluteFill style={{ backgroundColor: value.brand.background, fontFamily: value.brand.font, color: value.brand.text }}>
          <Scene {...(raw as P)} />
          {p.captions.auto && p.words.length ? <Captions style={p.captions.style} position={p.captions.position} /> : null}
        </AbsoluteFill>
        {p.audio && AudioTag ? <AudioTag src={staticFile(p.audio)} /> : null}
        {p.music && AudioTag ? <AudioTag src={staticFile(p.music.file)} loop volume={(f: number) => musicLevel * fade(f)} /> : null}
      </MC.Provider>
    );
  };
  return Wrapped;
}

// ------------------------------------------------------------------ timing helpers

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Seconds → frames. */
export function useSeconds(): (s: number) => number {
  const { fps } = useVideoConfig();
  return (s: number) => Math.round(s * fps);
}

/** The frame (from the start of the video) when a word is first spoken, or null. */
export function cueFrame(word: string, fps: number, nth = 1): number | null {
  const target = norm(word);
  let seen = 0;
  for (const w of current.words) {
    if (norm(w.text).startsWith(target) && ++seen >= nth) return Math.round(w.start * fps);
  }
  return null;
}

/** The word being spoken right now, its index, and how far through it we are. */
export function useSpokenWord(): { word: Word | null; index: number } {
  const { words, frame } = useMC();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  let index = -1;
  for (let i = 0; i < words.length; i++) if (words[i].start <= t) index = i;
  const word = index >= 0 && t <= words[index].end + 0.25 ? words[index] : null;
  return { word, index: word ? index : -1 };
}

/**
 * The beat: music beats when there's a music track, otherwise the start of each
 * spoken word. pulse is 1 on the beat and fades to 0; use it for scale or glow.
 */
export function useBeat(): { index: number; pulse: number; sinceBeat: number } {
  const { music, words, frame } = useMC();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const beats = music?.beats.length ? music.beats : words.map((w) => w.start);
  let index = -1;
  for (let i = 0; i < beats.length; i++) if (beats[i] <= t) index = i;
  const since = index >= 0 ? t - beats[index] : 99;
  return { index, sinceBeat: since, pulse: Math.exp(-since * 7) };
}

/** Fade + slide for anything placed in a <Sequence>. */
export function useEnter(delay = 0, exit = true): { opacity: number; y: number; scale: number } {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  const out = exit ? interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp) : 1;
  return { opacity: Math.min(s, out), y: (1 - s) * 40, scale: 0.92 + 0.08 * s };
}

const useScale = () => {
  const { width, height } = useVideoConfig();
  return Math.min(width, height) / 1080;
};

// ------------------------------------------------------------------ captions

type Group = { words: (Word & { i: number })[]; start: number; end: number };

/** Splits words into short caption lines. */
export function captionGroups(words: Word[], maxWords: number): Group[] {
  const groups: Group[] = [];
  let cur: (Word & { i: number })[] = [];
  const flush = () => {
    if (cur.length) groups.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = cur[cur.length - 1];
    if (prev && (cur.length >= maxWords || w.start - prev.end > 0.5)) flush();
    cur.push({ ...w, i });
    if (/[.!?;:,…]["')\]]*$/.test(w.text)) flush();
  });
  flush();
  return groups;
}

/** Word-by-word captions synced to the voiceover. */
export const Captions: React.FC<{ style?: CaptionStyle; position?: "bottom" | "center" | "top"; maxWords?: number; size?: number }> = ({
  style = "karaoke",
  position = "bottom",
  maxWords,
  size,
}) => {
  const { words, frame, brand: b } = useMC();
  const { fps, width, height } = useVideoConfig();
  const k = useScale();
  if (!words.length) return null;
  const t = frame / fps;
  const groups = captionGroups(words, maxWords ?? (height > width ? 3 : 5));
  const gi = groups.findIndex((g, i) => t >= g.start - 0.05 && t < (groups[i + 1]?.start ?? g.end + 0.8) && t <= g.end + 0.8);
  if (gi < 0) return null;
  const g = groups[gi];
  const fontSize = (size ?? (height > width ? 78 : 64)) * k;
  const place: React.CSSProperties =
    position === "center" ? { justifyContent: "center" } : position === "top" ? { justifyContent: "flex-start", paddingTop: height * 0.08 } : { justifyContent: "flex-end", paddingBottom: height * 0.08 };
  return (
    <AbsoluteFill style={{ alignItems: "center", ...place, pointerEvents: "none" }}>
      <div
        style={{
          maxWidth: width * 0.86,
          textAlign: "center",
          fontFamily: b.font,
          fontWeight: 800,
          fontSize,
          lineHeight: 1.2,
          padding: `${0.25 * fontSize}px ${0.5 * fontSize}px`,
          borderRadius: 0.3 * fontSize,
          background: style === "block" ? "rgba(0,0,0,0.6)" : "transparent",
          textShadow: style === "block" ? "none" : "0 3px 12px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)",
        }}
      >
        {g.words.map((w) => {
          const active = t >= w.start && t < (words[w.i + 1]?.start ?? w.end + 0.3);
          const said = t >= w.start;
          const pop = spring({ frame: frame - Math.round(w.start * fps), fps, config: { damping: 14, mass: 0.6 } });
          const visible = style === "pop" ? said : true;
          return (
            <span
              key={w.i}
              style={{
                display: "inline-block",
                margin: `0 ${0.14 * fontSize}px`,
                color: style === "block" ? b.text : active ? b.accent : said || style !== "karaoke" ? b.text : "rgba(255,255,255,0.55)",
                opacity: visible ? 1 : 0,
                transform: `scale(${style === "pop" ? 0.6 + 0.4 * pop : active ? 1.08 : 1})`,
              }}
            >
              {w.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ brand pieces

/** A soft animated gradient in the brand colours. */
export const Background: React.FC<{ variant?: "gradient" | "grid" | "dots" }> = ({ variant = "gradient" }) => {
  const frame = useVideoFrame();
  const { brand: b } = useMC();
  const angle = 120 + frame * 0.3;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(${angle}deg, ${b.background} 0%, ${b.primary}55 55%, ${b.secondary}66 100%)` }}>
      {variant !== "gradient" ? (
        <AbsoluteFill
          style={{
            opacity: 0.18,
            backgroundImage:
              variant === "grid"
                ? `linear-gradient(${b.text}33 1px, transparent 1px), linear-gradient(90deg, ${b.text}33 1px, transparent 1px)`
                : `radial-gradient(${b.text}55 2px, transparent 2px)`,
            backgroundSize: variant === "grid" ? "80px 80px" : "40px 40px",
            backgroundPosition: `${-frame}px ${-frame * 0.5}px`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

/** The brand logo (from the asset dictionary), or the brand name when there isn't one. */
export const Logo: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 160, style }) => {
  const { brand: b, assets } = useMC();
  const k = useScale();
  if (b.logo && assets[b.logo]) return <Img src={staticFile(assets[b.logo].file)} style={{ height: size * k, objectFit: "contain", ...style }} />;
  if (!b.name) return null;
  return (
    <div style={{ fontFamily: b.font, fontWeight: 900, fontSize: size * 0.45 * k, letterSpacing: -1, color: b.text, padding: `${10 * k}px ${24 * k}px`, borderRadius: 18 * k, border: `${4 * k}px solid ${b.accent}`, ...style }}>
      {b.name}
    </div>
  );
};

/** A picture or video clip, filling the frame with a slow zoom. Use an asset id, a URL or images[n]. */
export const Media: React.FC<{ id?: string; src?: string; zoom?: boolean; fit?: "cover" | "contain"; dim?: number; style?: React.CSSProperties }> = ({
  id,
  src,
  zoom = true,
  fit = "cover",
  dim = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const { assets } = useMC();
  const a = id ? assets[id] : undefined;
  if (id && !a) throw new Error(`No asset "${id}" was given to this video. Available: ${Object.keys(assets).join(", ") || "none"}`);
  const url = a ? staticFile(a.file) : src;
  if (!url) return null;
  const scale = zoom ? interpolate(frame, [0, durationInFrames], [1, 1.12], clamp) : 1;
  const css: React.CSSProperties = { width: "100%", height: "100%", objectFit: fit, transform: `scale(${scale})`, ...style };
  const clipFrames = a?.seconds ? Math.max(1, Math.floor(a.seconds * fps)) : 0;
  const video = a?.kind === "video" ? <OffthreadVideo src={url} muted style={css} /> : null;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {video ? (clipFrames && clipFrames < durationInFrames ? <Loop durationInFrames={clipFrames}>{video}</Loop> : video) : <Img src={url} style={css} />}
      {dim > 0 ? <AbsoluteFill style={{ backgroundColor: `rgba(0,0,0,${dim})` }} /> : null}
    </AbsoluteFill>
  );
};

/** A big title with an optional subtitle. Put it in a <Sequence>. */
export const TitleCard: React.FC<{ title: string; subtitle?: string; align?: "center" | "left" }> = ({ title, subtitle, align = "center" }) => {
  const { brand: b } = useMC();
  const k = useScale();
  const e = useEnter();
  const sub = useEnter(8);
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: align === "center" ? "center" : "flex-start", padding: 100 * k, textAlign: align }}>
      <div style={{ opacity: e.opacity, transform: `translateY(${e.y}px)`, fontFamily: b.font, fontWeight: 900, fontSize: 110 * k, lineHeight: 1.05, color: b.text, maxWidth: "90%" }}>{title}</div>
      <div style={{ width: 160 * k * e.opacity, height: 10 * k, background: b.accent, borderRadius: 5 * k, margin: `${28 * k}px 0` }} />
      {subtitle ? <div style={{ opacity: sub.opacity * 0.85, transform: `translateY(${sub.y}px)`, fontFamily: b.font, fontSize: 46 * k, color: b.text, maxWidth: "80%" }}>{subtitle}</div> : null}
    </AbsoluteFill>
  );
};

/** A name strip in the lower left. */
export const LowerThird: React.FC<{ name: string; role?: string }> = ({ name, role }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { brand: b, words } = useMC();
  const k = useScale();
  const s = spring({ frame, fps, config: { damping: 200 } });
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [0, 1], clamp);
  const x = interpolate(s - out, [0, 1], [-700 * k, 0]);
  // Above the captions when there are any
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", padding: `0 0 ${(words.length ? 250 : 120) * k}px ${80 * k}px` }}>
      <div style={{ transform: `translateX(${x}px)`, display: "flex", alignItems: "stretch", fontFamily: b.font }}>
        <div style={{ width: 14 * k, background: b.accent }} />
        <div style={{ background: `${b.background}e6`, padding: `${18 * k}px ${32 * k}px` }}>
          <div style={{ fontSize: 52 * k, fontWeight: 800, color: b.text }}>{name}</div>
          {role ? <div style={{ fontSize: 32 * k, color: b.text, opacity: 0.8 }}>{role}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Words that pop in one after another. */
export const KineticText: React.FC<{ text: string; perWord?: number; size?: number; color?: string; align?: "center" | "top" }> = ({ text, perWord = 5, size = 96, color, align = "center" }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, height } = useVideoConfig();
  const { brand: b } = useMC();
  const k = useScale();
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: align === "top" ? "flex-start" : "center", alignItems: "center", padding: 90 * k, paddingTop: align === "top" ? height * 0.14 : 90 * k }}>
      <div style={{ textAlign: "center", fontFamily: b.font, fontWeight: 900, fontSize: size * k, lineHeight: 1.15, color: color ?? b.text, opacity: out }}>
        {text.split(/\s+/).map((w, i) => {
          const s = spring({ frame: frame - i * perWord, fps, config: { damping: 12, mass: 0.5 } });
          return (
            <span key={i} style={{ display: "inline-block", margin: `0 ${0.15 * size * k}px`, opacity: Math.min(1, s * 1.5), transform: `translateY(${(1 - s) * 50}px) scale(${0.7 + 0.3 * s})` }}>
              {w}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Points that appear one after another. */
export const BulletList: React.FC<{ items: string[]; title?: string; stagger?: number }> = ({ items, title, stagger }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { brand: b } = useMC();
  const k = useScale();
  const gap = stagger ?? Math.max(6, Math.floor((durationInFrames * 0.6) / Math.max(1, items.length)));
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: `0 ${120 * k}px`, opacity: out, fontFamily: b.font }}>
      {title ? <div style={{ fontSize: 72 * k, fontWeight: 900, color: b.text, marginBottom: 40 * k }}>{title}</div> : null}
      {items.map((it, i) => {
        const s = spring({ frame: frame - i * gap, fps, config: { damping: 200 } });
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 28 * k, margin: `${14 * k}px 0`, opacity: s, transform: `translateX(${(1 - s) * 60}px)` }}>
            <div style={{ width: 22 * k, height: 22 * k, borderRadius: 11 * k, background: b.accent, flex: "none" }} />
            <div style={{ fontSize: 54 * k, color: b.text, lineHeight: 1.2 }}>{it}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/** Logo, a line and a call to action, for the last seconds. */
export const EndCard: React.FC<{ text?: string; cta?: string }> = ({ text, cta }) => {
  const { brand: b } = useMC();
  const k = useScale();
  const e = useEnter(0, false);
  const c = useEnter(10, false);
  const { pulse } = useBeat();
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 36 * k, fontFamily: b.font, textAlign: "center" }}>
      <div style={{ opacity: e.opacity, transform: `scale(${e.scale})` }}>
        <Logo size={200} />
      </div>
      {text || b.tagline ? <div style={{ opacity: e.opacity, fontSize: 60 * k, fontWeight: 800, color: b.text, maxWidth: "80%" }}>{text || b.tagline}</div> : null}
      {cta ? (
        <div style={{ opacity: c.opacity, transform: `scale(${c.scale + pulse * 0.04})`, background: b.accent, color: b.background, fontWeight: 900, fontSize: 44 * k, padding: `${18 * k}px ${44 * k}px`, borderRadius: 999 }}>
          {cta}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

/** A <Sequence> that fades in and out. */
export const Section: React.FC<{ from: number; durationInFrames: number; children: React.ReactNode; fade?: number }> = ({ from, durationInFrames, children, fade = 8 }) => (
  <Sequence from={from} durationInFrames={durationInFrames}>
    <Fade frames={fade}>{children}</Fade>
  </Sequence>
);

const Fade: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const o = Math.min(interpolate(frame, [0, frames], [0, 1], clamp), interpolate(frame, [durationInFrames - frames, durationInFrames], [1, 0], clamp));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

// ------------------------------------------------------------------ templates

/** Splits the video into parts by weight: [[2],[1],[1]] → frames for each part. */
function parts(total: number, weights: number[]): { from: number; dur: number }[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return weights.map((w, i) => {
    const dur = i === weights.length - 1 ? total - at : Math.max(1, Math.round((total * w) / sum));
    const p = { from: at, dur };
    at += dur;
    return p;
  });
}

/** Background pictures (asset ids, URLs or images[n]) cycling behind the content, or the brand gradient. */
const Backdrop: React.FC<{ media?: string[]; dim?: number }> = ({ media, dim = 0.55 }) => {
  const { durationInFrames } = useVideoConfig();
  const { assets } = useMC();
  if (!media?.length) return <Background variant="dots" />;
  const p = parts(durationInFrames, media.map(() => 1));
  return (
    <AbsoluteFill>
      {media.map((m, i) => (
        <Section key={i} from={p[i].from} durationInFrames={p[i].dur} fade={i === 0 ? 0 : 10}>
          {assets[m] ? <Media id={m} dim={dim} /> : <Media src={m} dim={dim} />}
        </Section>
      ))}
    </AbsoluteFill>
  );
};

/** Title → points → logo and call to action. Fills any length. */
export const Promo: React.FC<{ title: string; subtitle?: string; points?: string[]; cta?: string; media?: string[] }> = ({ title, subtitle, points = [], cta, media }) => {
  const { durationInFrames } = useVideoConfig();
  const p = parts(durationInFrames, [2.2, ...points.map(() => 1.4), 2]);
  return (
    <AbsoluteFill>
      <Backdrop media={media} />
      <Section from={p[0].from} durationInFrames={p[0].dur}>
        <TitleCard title={title} subtitle={subtitle} />
      </Section>
      {points.map((pt, i) => (
        <Section key={i} from={p[i + 1].from} durationInFrames={p[i + 1].dur}>
          <KineticText text={pt} size={84} />
        </Section>
      ))}
      <Section from={p[p.length - 1].from} durationInFrames={p[p.length - 1].dur}>
        <EndCard cta={cta} />
      </Section>
    </AbsoluteFill>
  );
};

/** Numbered steps, one at a time, ending on the logo. */
export const Explainer: React.FC<{ title: string; steps: { title: string; text?: string }[]; media?: string[] }> = ({ title, steps, media }) => {
  const { durationInFrames } = useVideoConfig();
  const { brand: b } = useMC();
  const k = useScale();
  const p = parts(durationInFrames, [1.5, ...steps.map(() => 2), 1.2]);
  return (
    <AbsoluteFill>
      <Backdrop media={media} dim={0.65} />
      <Section from={p[0].from} durationInFrames={p[0].dur}>
        <TitleCard title={title} />
      </Section>
      {steps.map((s, i) => (
        <Section key={i} from={p[i + 1].from} durationInFrames={p[i + 1].dur}>
          <Step n={i + 1} of={steps.length} title={s.title} text={s.text} color={b.accent} k={k} />
        </Section>
      ))}
      <Section from={p[p.length - 1].from} durationInFrames={p[p.length - 1].dur}>
        <EndCard />
      </Section>
    </AbsoluteFill>
  );
};

const Step: React.FC<{ n: number; of: number; title: string; text?: string; color: string; k: number }> = ({ n, of, title, text, color, k }) => {
  const e = useEnter();
  const t = useEnter(8);
  const { brand: b } = useMC();
  return (
    <AbsoluteFill style={{ justifyContent: "center", padding: `0 ${130 * k}px`, fontFamily: b.font }}>
      <div style={{ display: "flex", alignItems: "center", gap: 36 * k, opacity: e.opacity, transform: `translateY(${e.y}px)` }}>
        <div style={{ width: 130 * k, height: 130 * k, borderRadius: 65 * k, background: color, color: b.background, fontSize: 72 * k, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>{n}</div>
        <div style={{ fontSize: 80 * k, fontWeight: 900, color: b.text, lineHeight: 1.1 }}>{title}</div>
      </div>
      {text ? <div style={{ marginTop: 34 * k, marginLeft: 166 * k, fontSize: 46 * k, color: b.text, opacity: t.opacity * 0.9, transform: `translateY(${t.y}px)`, maxWidth: "75%" }}>{text}</div> : null}
      <div style={{ position: "absolute", bottom: 70 * k, left: 130 * k, fontSize: 30 * k, color: b.text, opacity: 0.6 }}>
        Step {n} of {of}
      </div>
    </AbsoluteFill>
  );
};

/**
 * For vertical shorts: a hook, then punchy lines, ending on the logo. With a voiceover,
 * big captions follow every word from the start and the hook sits above them.
 */
export const Social: React.FC<{ hook: string; lines?: string[]; media?: string[]; cta?: string }> = ({ hook, lines = [], media, cta }) => {
  const { durationInFrames, fps } = useVideoConfig();
  const { words } = useMC();
  const hookLen = Math.min(durationInFrames, Math.round(fps * 2.8));
  // The end card takes whatever is left after the last word (or the last 1.5 s)
  const spoken = words.length ? Math.round((words[words.length - 1].end + 0.4) * fps) : durationInFrames - Math.round(fps * 1.5);
  const endFrom = Math.max(hookLen, Math.min(durationInFrames, spoken));
  const endLen = durationInFrames - endFrom;
  const rest = parts(Math.max(1, endFrom - hookLen), lines.length ? lines.map(() => 1) : [1]);
  return (
    <AbsoluteFill>
      <Backdrop media={media} dim={0.45} />
      <Section from={0} durationInFrames={hookLen} fade={4}>
        <KineticText text={hook} size={words.length ? 92 : 104} perWord={3} align={words.length ? "top" : "center"} />
      </Section>
      {words.length
        ? null
        : lines.map((l, i) => (
            <Section key={i} from={hookLen + rest[i].from} durationInFrames={rest[i].dur}>
              <KineticText text={l} size={88} perWord={4} />
            </Section>
          ))}
      {words.length ? (
        <Sequence from={0} durationInFrames={endFrom}>
          <Captions style="pop" position="center" size={96} />
        </Sequence>
      ) : null}
      {endLen >= fps * 0.8 ? (
        <Section from={endFrom} durationInFrames={endLen}>
          <EndCard cta={cta} />
        </Section>
      ) : null}
    </AbsoluteFill>
  );
};

/** A quote on screen, word by word, with who said it. */
export const Quote: React.FC<{ quote: string; author?: string; media?: string[] }> = ({ quote, author, media }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  const { brand: b } = useMC();
  const k = useScale();
  const words = quote.split(/\s+/);
  const per = Math.max(2, Math.floor((durationInFrames * 0.6) / words.length));
  const a = spring({ frame: frame - words.length * per, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill>
      <Backdrop media={media} dim={0.6} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: 140 * k, fontFamily: b.font, textAlign: "center" }}>
        <div style={{ fontSize: 200 * k, lineHeight: 0.6, color: b.accent, fontFamily: "Liberation Serif, serif" }}>“</div>
        <div style={{ fontSize: 76 * k, fontWeight: 700, lineHeight: 1.25, color: b.text }}>
          {words.map((w, i) => (
            <span key={i} style={{ opacity: interpolate(frame, [i * per, i * per + per * 2], [0.15, 1], { ...clamp, easing: Easing.out(Easing.quad) }) }}>{w} </span>
          ))}
        </div>
        {author ? <div style={{ marginTop: 50 * k, fontSize: 42 * k, color: b.text, opacity: a * 0.85 }}>— {author}</div> : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
