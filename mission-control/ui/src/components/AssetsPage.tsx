import { useEffect, useRef, useState } from "react";
import { HARNESS_URL, authHeaders } from "../config";
import { getJson, send } from "../api";

// The asset dictionary: logos, pictures, clips, music and fonts the Coder may use in
// videos, each with a description so it picks the right one. Plus the brand the
// video templates follow, and the voice for voiceovers.

type Kind = "image" | "video" | "audio" | "font";
type Role = "logo" | "picture" | "broll" | "music" | "sound" | "font";
interface Asset {
  id: string;
  name: string;
  kind: Kind;
  role: Role;
  ext: string;
  bytes: number;
  description: string;
  tags: string[];
  seconds?: number;
  tempo?: number | null;
  beats?: number[];
  uses: number;
}
interface Brand {
  name: string;
  tagline: string;
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  font: string;
  logo: string | null;
  fontAsset: string | null;
  voice: string;
  speed: number;
  captionStyle: "karaoke" | "pop" | "block";
}
interface Data {
  assets: Asset[];
  brand: Brand;
  fonts: string[];
  voices: { id: string; label: string }[];
  voice: "off" | "down" | "loading" | "ready" | "partial";
  voiceError: string | null;
  whisper: string | null;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "");
const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const fileUrl = (id: string) => `${HARNESS_URL}/api/assets/${id}/file`;
const size = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const ROLES: Record<Kind, Role[]> = { image: ["picture", "logo"], video: ["broll"], audio: ["music", "sound"], font: ["font"] };
const ROLE_LABEL: Record<Role, string> = { logo: "Logo", picture: "Picture", broll: "B-roll clip", music: "Music", sound: "Sound effect", font: "Font" };
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,video/mp4,video/quicktime,video/webm,audio/*,.ttf,.otf,.woff,.woff2";
const VOICE_STATUS: Record<Data["voice"], string> = {
  off: "Voiceovers are off: no voice service is set up (VOICE_URL).",
  down: "The voice service isn't answering. Is the voice container running?",
  loading: "The voice service is loading its models…",
  ready: "Voice service ready.",
  partial: "The voice service is running with problems:",
};

/** Reads a file as a data URL, with its length (audio, video) or size (pictures) when the browser can tell. */
async function readFile(file: File): Promise<{ data: string; seconds?: number; width?: number; height?: number }> {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("audio/") || file.type.startsWith("video/")) {
      const el = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
      el.preload = "metadata";
      el.src = url;
      await new Promise<void>((resolve) => {
        el.onloadedmetadata = () => resolve();
        el.onerror = () => resolve();
        setTimeout(resolve, 4000);
      });
      const seconds = Number.isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration * 10) / 10 : undefined;
      const v = el as HTMLVideoElement;
      return { data, seconds, width: v.videoWidth || undefined, height: v.videoHeight || undefined };
    }
    if (file.type.startsWith("image/") && file.type !== "image/svg+xml") {
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {});
      return { data, width: img.naturalWidth || undefined, height: img.naturalHeight || undefined };
    }
    return { data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const niceName = (file: string) =>
  file
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "Asset";

function FontSample({ id, className }: { id: string; className?: string }) {
  const family = `asset-${id}`;
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const face = new FontFace(family, `url(${fileUrl(id)})`);
    face
      .load()
      .then((f) => {
        (document.fonts as unknown as { add: (f: FontFace) => void }).add(f);
        setOk(true);
      })
      .catch(() => setOk(false));
  }, [id, family]);
  return <div className={className} style={{ fontFamily: ok ? family : "inherit" }}>Aa Bb 123</div>;
}

function Preview({ a }: { a: Asset }) {
  const box = "w-full h-32 rounded-md bg-slate-950 border border-slate-800 object-contain";
  if (a.kind === "image") return <img src={fileUrl(a.id)} alt={a.name} className={box} />;
  if (a.kind === "video") return <video src={fileUrl(a.id)} className={box} muted controls preload="metadata" />;
  if (a.kind === "audio")
    return (
      <div className={`${box} flex flex-col items-center justify-center gap-2 px-2`}>
        <span className="text-3xl">{a.role === "music" ? "🎵" : "🔊"}</span>
        <audio src={fileUrl(a.id)} controls preload="none" className="w-full h-8" />
      </div>
    );
  return <FontSample id={a.id} className={`${box} flex items-center justify-center text-3xl text-slate-200`} />;
}

function AssetCard({ a, onChange, onError }: { a: Asset; onChange: () => Promise<void>; onError: (e: string) => void }) {
  const [f, setF] = useState({ name: a.name, description: a.description, tags: a.tags.join(", "), role: a.role });
  const [busy, setBusy] = useState("");
  useEffect(() => setF({ name: a.name, description: a.description, tags: a.tags.join(", "), role: a.role }), [a.name, a.description, a.tags, a.role]);
  const dirty = f.name !== a.name || f.description !== a.description || f.tags !== a.tags.join(", ") || f.role !== a.role;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      await onChange();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-3 space-y-2 text-xs">
      <Preview a={a} />
      <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={60} className={input} aria-label="Name" />
      <textarea
        value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })}
        rows={2}
        maxLength={400}
        placeholder="What it shows or sounds like (the Coder picks assets by this)"
        className={input}
      />
      <input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="Tags, comma separated" className={input} />
      <div className="flex items-center gap-2 text-slate-400">
        {ROLES[a.kind].length > 1 ? (
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })} className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-slate-200">
            {ROLES[a.kind].map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ) : (
          <span className="px-2 py-1 rounded-md bg-slate-800 text-slate-300">{ROLE_LABEL[a.role]}</span>
        )}
        <span>
          {a.ext.toUpperCase()} · {size(a.bytes)}
          {a.seconds ? ` · ${Math.round(a.seconds)} s` : ""}
          {a.uses ? ` · used ${a.uses}×` : ""}
        </span>
      </div>
      {a.role === "music" && (
        <div className="flex items-center gap-2 text-slate-400">
          <span>{a.beats ? (a.tempo ? `${Math.round(a.tempo)} BPM · ${a.beats.length} beats` : "No clear beat found") : "Beats not found yet"}</span>
          <button onClick={() => void run("beats", () => send("POST", `/api/assets/${a.id}/beats`))} disabled={Boolean(busy)} className="ml-auto px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-50">
            {busy === "beats" ? "Listening…" : a.beats ? "Find again" : "Find beats"}
          </button>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <code className="text-[10px] text-slate-500 self-center truncate" title="The id the Coder uses">
          {a.id}
        </code>
        <button
          onClick={() => {
            if (confirm(`Delete "${a.name}"? Videos already made keep it.`)) void run("delete", () => send("DELETE", `/api/assets/${a.id}`));
          }}
          disabled={Boolean(busy)}
          className="ml-auto px-2 py-1 rounded-md bg-slate-800 hover:bg-rose-900 text-slate-300 disabled:opacity-50"
        >
          Delete
        </button>
        <button
          onClick={() =>
            void run("save", () =>
              send("PATCH", `/api/assets/${a.id}`, {
                name: f.name.trim(),
                description: f.description.trim(),
                tags: f.tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .slice(0, 12),
                role: f.role,
              }),
            )
          }
          disabled={!dirty || Boolean(busy) || !f.name.trim()}
          className="px-3 py-1 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-40"
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function BrandForm({ data, onSaved, onError }: { data: Data; onSaved: () => Promise<void>; onError: (e: string) => void }) {
  const [b, setB] = useState<Brand>(data.brand);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => setB(data.brand), [data.brand]);
  const logos = data.assets.filter((a) => a.kind === "image");
  const fonts = data.assets.filter((a) => a.kind === "font");
  const colors: [keyof Brand, string][] = [
    ["primary", "Primary"],
    ["secondary", "Secondary"],
    ["accent", "Accent"],
    ["background", "Background"],
    ["text", "Text"],
  ];
  const tryVoice = async () => {
    setBusy("voice");
    try {
      const r = await fetch(`${HARNESS_URL}/api/voice/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ voice: b.voice, speed: b.speed, text: b.name ? `This is ${b.name}. ${b.tagline || "Here's how your videos will sound."}` : undefined }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `The voice service said ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      audio.current?.pause();
      audio.current = new Audio(url);
      await audio.current.play();
    } catch (e) {
      onError(errText(e));
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-200">Brand</h2>
        <p className="text-xs text-slate-500">The video templates use these colours, font, logo and voice. Set them once; every video follows them.</p>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} placeholder="Brand name" maxLength={60} className={input} />
        <input value={b.tagline} onChange={(e) => setB({ ...b, tagline: e.target.value })} placeholder="Tagline (shown on end cards)" maxLength={120} className={input} />
      </div>
      <div className="flex flex-wrap items-end gap-4 text-xs text-slate-400">
        {colors.map(([key, label]) => (
          <label key={key} className="flex flex-col gap-1">
            {label}
            <span className="flex items-center gap-1">
              <input type="color" value={b[key] as string} onChange={(e) => setB({ ...b, [key]: e.target.value })} className="h-8 w-10 rounded bg-transparent cursor-pointer" />
              <code className="text-slate-500">{b[key] as string}</code>
            </span>
          </label>
        ))}
        <div
          className="ml-auto rounded-lg px-4 py-3 min-w-[220px]"
          style={{ background: `linear-gradient(120deg, ${b.background}, ${b.primary}88 60%, ${b.secondary}99)`, color: b.text, fontFamily: b.font === "brand" ? undefined : b.font }}
          title="A rough preview"
        >
          <div className="font-black text-base">{b.name || "Your brand"}</div>
          <div className="text-xs opacity-80">{b.tagline || "Tagline"}</div>
          <span className="inline-block mt-2 px-3 py-0.5 rounded-full text-xs font-bold" style={{ background: b.accent, color: b.background }}>
            Call to action
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 text-xs text-slate-400">
        <label className="space-y-1">
          <span>Logo</span>
          <select value={b.logo ?? ""} onChange={(e) => setB({ ...b, logo: e.target.value || null })} className={input}>
            <option value="">None (show the brand name)</option>
            {logos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span>Font</span>
          <select
            value={b.font === "brand" ? `asset:${b.fontAsset}` : b.font}
            onChange={(e) => (e.target.value.startsWith("asset:") ? setB({ ...b, font: "brand", fontAsset: e.target.value.slice(6) }) : setB({ ...b, font: e.target.value }))}
            className={input}
          >
            {data.fonts.map((f) => (
              <option key={f} value={f}>
                {f.split(",")[0]}
              </option>
            ))}
            {fonts.map((a) => (
              <option key={a.id} value={`asset:${a.id}`}>
                {a.name} (uploaded)
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span>Voice</span>
          <span className="flex gap-1">
            <select value={b.voice} onChange={(e) => setB({ ...b, voice: e.target.value })} className={input}>
              {data.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <button onClick={() => void tryVoice()} disabled={Boolean(busy) || data.voice === "off"} className="px-2 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40" title="Hear this voice">
              {busy === "voice" ? "…" : "▶"}
            </button>
          </span>
        </label>
        <label className="space-y-1">
          <span>Speed {b.speed.toFixed(2)}× · captions</span>
          <span className="flex gap-1">
            <input type="range" min={0.7} max={1.4} step={0.05} value={b.speed} onChange={(e) => setB({ ...b, speed: Number(e.target.value) })} className="w-full" />
            <select value={b.captionStyle} onChange={(e) => setB({ ...b, captionStyle: e.target.value as Brand["captionStyle"] })} className="bg-slate-950 border border-slate-700 rounded-md px-2 text-slate-200">
              <option value="karaoke">Karaoke</option>
              <option value="pop">Pop</option>
              <option value="block">Block</option>
            </select>
          </span>
        </label>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <span className={data.voice === "ready" ? "text-emerald-400" : "text-amber-300"}>
          {VOICE_STATUS[data.voice]} {data.voiceError ?? ""} {data.voice === "ready" && data.whisper ? `Word timings by Whisper ${data.whisper}.` : ""}
        </span>
        {saved && <span className="text-emerald-400">Saved</span>}
        <button
          onClick={async () => {
            setBusy("save");
            setSaved(false);
            try {
              await send("PUT", "/api/brand", b);
              await onSaved();
              setSaved(true);
            } catch (e) {
              onError(errText(e));
            } finally {
              setBusy("");
            }
          }}
          disabled={Boolean(busy)}
          className="ml-auto px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : "Save brand"}
        </button>
      </div>
    </section>
  );
}

export default function AssetsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const load = () =>
    getJson<Data>("/api/assets")
      .then(setData)
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
  }, []);

  const upload = async (list: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(list)) {
      setUploading((u) => [...u, file.name]);
      try {
        const info = await readFile(file);
        await send("POST", "/api/assets", { name: niceName(file.name), description: "", tags: [], ...info });
      } catch (e) {
        setError(`${file.name}: ${errText(e)}`);
      } finally {
        setUploading((u) => u.filter((n) => n !== file.name));
      }
    }
    await load();
  };

  if (!data) return <div className="col-span-3 p-6 text-slate-500">{error ?? "Loading assets…"}</div>;
  const shown = data.assets.filter((a) => filter === "all" || a.kind === filter);
  const counts = (k: Kind) => data.assets.filter((a) => a.kind === k).length;

  return (
    <div className="col-span-3 min-h-0 overflow-y-auto space-y-4 pr-1">
      <BrandForm data={data} onSaved={load} onError={setError} />
      <section
        className={`bg-slate-900 border rounded-xl p-4 space-y-3 ${drag ? "border-cyan-500" : "border-slate-800"}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold text-slate-200">Asset dictionary</h2>
          <p className="text-xs text-slate-500 flex-1 min-w-[260px]">
            Your logos, pictures, B-roll, music and fonts. Describe each one: when you ask for a video, the assets whose words match your request go to the Coder, which uses them instead of inventing visuals. Ask for "music" to get a track.
          </p>
          <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && void upload(e.target.files)} />
          <button onClick={() => picker.current?.click()} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium">
            ＋ Add files
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {(
            [
              ["all", `All ${data.assets.length}`],
              ["image", `Pictures ${counts("image")}`],
              ["video", `Clips ${counts("video")}`],
              ["audio", `Audio ${counts("audio")}`],
              ["font", `Fonts ${counts("font")}`],
            ] as ["all" | Kind, string][]
          ).map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1 rounded-md ${filter === k ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}>
              {label}
            </button>
          ))}
          {uploading.length > 0 && <span className="ml-3 text-cyan-300">Uploading {uploading.join(", ")}…</span>}
        </div>
        {error && <p className="text-xs text-rose-300">{error}</p>}
        {shown.length === 0 ? (
          <div className="border border-dashed border-slate-700 rounded-xl p-8 text-center text-sm text-slate-500">
            Drop files here, or press Add files. Pictures (PNG, JPEG, WebP, SVG), clips (MP4, MOV, WebM), audio (WAV, MP3, M4A, OGG) and fonts (TTF, OTF, WOFF).
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
            {shown.map((a) => (
              <AssetCard key={a.id} a={a} onChange={load} onError={setError} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
