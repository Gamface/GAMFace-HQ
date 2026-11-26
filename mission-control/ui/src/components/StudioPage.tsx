import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getJson, send } from "../api";
import { HARNESS_URL } from "../config";
import VideoStudio from "./VideoStudio";

// The music studio: add songs (or write new ones with ACE-Step on the graphics card), split them
// into stems, then make practice tracks, karaoke, sheet music and DAW exports. The work runs in
// the studio container; songs and GPU stems go through ComfyUI on Windows.

interface Health {
  comfy: boolean;
  comfyUrl: string;
  aceStep: string | null;
  gpuStems: boolean;
  musescore: boolean;
  rubberband: boolean;
  voice: boolean;
  stock?: { pexels: boolean; pixabay: boolean };
}

interface Song {
  id: string;
  title: string;
  source: "upload" | "ace-step";
  status: "new" | "splitting" | "ready" | "failed";
  stems: string[];
  splitBy?: "gpu" | "cpu";
  duration?: number;
  error?: string;
  bpm?: number;
  key?: string;
  prompt?: string;
  createdAt: number;
}

interface Job {
  id: string;
  type: string;
  title: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: string;
  error?: string;
  result?: { message: string; files: string[]; song?: string };
  params: { song?: string };
  createdAt: number;
}

interface Output {
  kind: string;
  name: string;
  at: number;
  files: string[];
}

type Tab = "stems" | "practice" | "karaoke" | "sheet" | "daw";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const btn = "px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50";
const primary = `${btn} bg-cyan-600 hover:bg-cyan-500 text-white`;
const quiet = `${btn} border border-slate-700 text-slate-300 hover:bg-slate-800`;
const fileUrl = (rel: string, download = false) => `${HARNESS_URL}/api/studio/files/${rel.split("/").map(encodeURIComponent).join("/")}${download ? "?download=1" : ""}`;
const mmss = (s?: number) => (s === undefined ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const STEM_COLOR: Record<string, string> = { vocals: "bg-rose-500", drums: "bg-amber-500", bass: "bg-violet-500", other: "bg-emerald-500" };
const KEYS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"].flatMap((k) => [`${k} major`, `${k} minor`]);

function Chip({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span title={title} className={`text-[11px] px-2 py-0.5 rounded border ${ok ? "border-emerald-800 bg-emerald-950 text-emerald-300" : "border-amber-800 bg-amber-950 text-amber-300"}`}>
      {ok ? "●" : "○"} {label}
    </span>
  );
}

/** One file from a result: players for audio, links for the rest. */
function FileLink({ rel }: { rel: string }) {
  const name = rel.split("/").pop() ?? rel;
  if (/\.mp4$/i.test(name))
    return (
      <div className="space-y-1">
        <video controls preload="metadata" src={fileUrl(rel)} className="max-h-72 max-w-full rounded border border-slate-800 bg-black" />
        <a href={fileUrl(rel, true)} className="text-[11px] text-cyan-400 hover:text-cyan-300 block truncate">
          {name}
        </a>
      </div>
    );
  if (/\.(png|jpe?g)$/i.test(name))
    return (
      <a href={fileUrl(rel, true)} className="inline-block">
        <img src={fileUrl(rel)} alt={name} className="h-20 rounded border border-slate-800" />
      </a>
    );
  if (/\.(mp3|wav|flac)$/i.test(name))
    return (
      <div className="flex items-center gap-2">
        <audio controls preload="none" src={fileUrl(rel)} className="h-8 max-w-xs" />
        <a href={fileUrl(rel, true)} className="text-[11px] text-cyan-400 hover:text-cyan-300 truncate">
          {name}
        </a>
      </div>
    );
  return (
    <a href={fileUrl(rel, !/\.(pdf|txt|lrc)$/i.test(name))} target="_blank" rel="noreferrer" className="text-[11px] text-cyan-400 hover:text-cyan-300 block truncate">
      {name}
    </a>
  );
}

// --- Stems mixer: every stem plays in sync in the browser ---------------------------------

function StemsMixer({ song }: { song: Song }) {
  const players = useRef<Record<string, HTMLAudioElement>>({});
  const [playing, setPlaying] = useState(false);
  const [levels, setLevels] = useState<Record<string, number>>(() => Object.fromEntries(song.stems.map((s) => [s, 1])));
  const [solo, setSolo] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  useEffect(() => {
    const els = players.current;
    return () => Object.values(els).forEach((a) => a.pause());
  }, []);
  useEffect(() => {
    for (const [s, a] of Object.entries(players.current)) a.volume = solo ? (s === solo ? 1 : 0) : levels[s] ?? 1;
  }, [levels, solo]);
  const all = () => Object.values(players.current);
  const toggle = async () => {
    if (playing) {
      all().forEach((a) => a.pause());
      setPlaying(false);
      return;
    }
    const t = all()[0]?.currentTime ?? 0;
    all().forEach((a) => (a.currentTime = t));
    await Promise.all(all().map((a) => a.play().catch(() => {})));
    setPlaying(true);
  };
  const seek = (t: number) => {
    all().forEach((a) => (a.currentTime = t));
    setTime(t);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button onClick={() => void toggle()} className={primary}>
          {playing ? "❚❚ Pause" : "▶ Play all"}
        </button>
        <input type="range" min={0} max={song.duration ?? 0} step={0.1} value={time} onChange={(e) => seek(Number(e.target.value))} className="flex-1" aria-label="Position" />
        <span className="text-xs text-slate-400 w-20 text-right">
          {mmss(time)} / {mmss(song.duration)}
        </span>
      </div>
      {song.stems.map((s, i) => (
        <div key={s} className="flex items-center gap-3">
          <audio
            ref={(el) => {
              if (el) players.current[s] = el;
            }}
            src={fileUrl(`library/${song.id}/stems/${s}.wav`)}
            preload="auto"
            onTimeUpdate={i === 0 ? (e) => setTime((e.target as HTMLAudioElement).currentTime) : undefined}
            onEnded={i === 0 ? () => setPlaying(false) : undefined}
          />
          <span className={`h-2.5 w-2.5 rounded-full ${STEM_COLOR[s] ?? "bg-slate-500"}`} />
          <span className="w-16 text-sm text-slate-200 capitalize">{s}</span>
          <button onClick={() => setLevels((l) => ({ ...l, [s]: (l[s] ?? 1) > 0 ? 0 : 1 }))} className={`${btn} border ${(levels[s] ?? 1) === 0 ? "border-rose-700 text-rose-300" : "border-slate-700 text-slate-400"}`}>
            M
          </button>
          <button onClick={() => setSolo((x) => (x === s ? null : s))} className={`${btn} border ${solo === s ? "border-amber-600 text-amber-300" : "border-slate-700 text-slate-400"}`}>
            S
          </button>
          <input type="range" min={0} max={1.5} step={0.05} value={levels[s] ?? 1} onChange={(e) => setLevels((l) => ({ ...l, [s]: Number(e.target.value) }))} className="flex-1" aria-label={`${s} level`} />
          <a href={fileUrl(`library/${song.id}/stems/${s}.wav`, true)} className="text-[11px] text-cyan-400 hover:text-cyan-300">
            WAV
          </a>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">Mute (M) or solo (S) parts while you listen. To keep a mix, use Practice.</p>
    </div>
  );
}

// --- The tools for one song ---------------------------------------------------------------

function SongTools({ song, health, onJob }: { song: Song; health: Health | null; onJob: () => void }) {
  const [tab, setTab] = useState<Tab>("stems");
  const [muted, setMuted] = useState<string[]>([]);
  const [speed, setSpeed] = useState(100);
  const [semis, setSemis] = useState(0);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [lyrics, setLyrics] = useState(true);
  const [backing, setBacking] = useState(false);
  const [parts, setParts] = useState<string[]>(["vocals", "bass"]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async (body: Record<string, unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await send("POST", "/api/studio/jobs", { song: song.id, ...body });
      setMsg("Started: see Jobs below.");
      onJob();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (song.status !== "ready")
    return (
      <div className="text-sm text-slate-400 space-y-2">
        {song.status === "failed" ? (
          <>
            <p className="text-rose-300">Splitting failed: {song.error}</p>
            <button disabled={busy} onClick={() => void submit({ type: "split" })} className={quiet}>
              Try again
            </button>
          </>
        ) : (
          <p>{song.status === "splitting" ? "Splitting into stems…" : "Waiting to be split into stems…"} {health?.gpuStems ? "(graphics card)" : "(CPU)"}</p>
        )}
      </div>
    );
  const TABS: [Tab, string][] = [
    ["stems", "Stems"],
    ["practice", "Practice"],
    ["karaoke", "Karaoke"],
    ["sheet", "Sheet music"],
    ["daw", "DAW"],
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`${btn} border ${tab === t ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "stems" && <StemsMixer key={song.id} song={song} />}
      {tab === "practice" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {song.stems.map((s) => (
              <button key={s} onClick={() => setMuted((m) => (m.includes(s) ? m.filter((x) => x !== s) : [...m, s]))} className={`${btn} border capitalize ${muted.includes(s) ? "border-rose-700 bg-rose-950 text-rose-300 line-through" : "border-slate-700 text-slate-300"}`}>
                {s}
              </button>
            ))}
            <span className="text-[11px] text-slate-500 self-center">Tap a part to leave it out (play it yourself)</span>
          </div>
          <label className="block text-xs text-slate-400">
            Speed: {speed}% (key stays the same)
            <input type="range" min={50} max={150} step={5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="w-full" disabled={!health?.rubberband} />
          </label>
          <label className="block text-xs text-slate-400">
            Key: {semis > 0 ? "+" : ""}
            {semis} semitones (speed stays the same)
            <input type="range" min={-12} max={12} step={1} value={semis} onChange={(e) => setSemis(Number(e.target.value))} className="w-full" disabled={!health?.rubberband} />
          </label>
          <div className="flex gap-3">
            <label className="text-xs text-slate-400">
              From (seconds)
              <input value={start} onChange={(e) => setStart(e.target.value)} className={`${input} mt-1 w-28`} placeholder="0" inputMode="decimal" />
            </label>
            <label className="text-xs text-slate-400">
              To (seconds)
              <input value={end} onChange={(e) => setEnd(e.target.value)} className={`${input} mt-1 w-28`} placeholder={String(Math.round(song.duration ?? 0))} inputMode="decimal" />
            </label>
          </div>
          <button
            disabled={busy || muted.length === song.stems.length}
            onClick={() =>
              void submit({
                type: "practice",
                gains: Object.fromEntries(muted.map((m) => [m, 0])),
                speed: speed / 100,
                semitones: semis,
                ...(start ? { start: Number(start) } : {}),
                ...(end ? { end: Number(end) } : {}),
              })
            }
            className={primary}
          >
            Make practice track
          </button>
        </div>
      )}
      {tab === "karaoke" && (
        <div className="space-y-3">
          <label className="block text-xs text-slate-400">
            Key: {semis > 0 ? "+" : ""}
            {semis} semitones
            <input type="range" min={-12} max={12} step={1} value={semis} onChange={(e) => setSemis(Number(e.target.value))} className="w-full" />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={lyrics} onChange={(e) => setLyrics(e.target.checked)} disabled={!health?.voice} />
            Timed lyrics (.lrc) from the vocals, by Whisper{!health?.voice && " (the voice service isn't set up)"}
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={backing} onChange={(e) => setBacking(e.target.checked)} />
            Keep the vocals quietly in the background (a guide)
          </label>
          <button disabled={busy} onClick={() => void submit({ type: "karaoke", semitones: semis, lyrics, keep_backing_vocals: backing })} className={primary}>
            Make karaoke
          </button>
          <p className="text-[11px] text-slate-500">The .lrc file works in karaoke players, VLC and FreeShow. Whisper's lyrics are a draft: check them.</p>
        </div>
      )}
      {tab === "sheet" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {song.stems
              .filter((s) => s !== "drums")
              .map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs text-slate-300 capitalize">
                  <input type="checkbox" checked={parts.includes(s)} onChange={(e) => setParts((p) => (e.target.checked ? [...p, s] : p.filter((x) => x !== s)))} />
                  {s}
                </label>
              ))}
          </div>
          <button disabled={busy || !parts.length} onClick={() => void submit({ type: "sheet", parts })} className={primary}>
            Write out the parts
          </button>
          <p className="text-[11px] text-slate-500">
            basic-pitch turns each part into MIDI notes{health?.musescore ? " and MuseScore engraves a PDF and MusicXML" : " (PDFs need MuseScore in the studio)"}. An automatic transcription: treat it as a draft. Drums have no notes to write out.
          </p>
        </div>
      )}
      {tab === "daw" && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">One ZIP with every stem (lined up at 0:00), a REAPER project and steps for Audacity and Ardour.</p>
          <button disabled={busy} onClick={() => void submit({ type: "daw" })} className={primary}>
            Export for a DAW
          </button>
        </div>
      )}
      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}

// --- New song (ACE-Step 1.5 in ComfyUI) ------------------------------------------------

function NewSong({ health, onJob }: { health: Health | null; onJob: () => void }) {
  const [f, setF] = useState({ prompt: "", title: "", lyrics: "", seconds: 60, bpm: 90, key: "A minor", timesig: "4", language: "en", split: true });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await send("POST", "/api/studio/jobs", { type: "song", ...f });
      setMsg("Writing it on the graphics card: see Jobs below. It lands in the library when it's done.");
      onJob();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 max-w-2xl">
      <h2 className="text-base font-semibold text-slate-100">New song (ACE-Step 1.5)</h2>
      {!health?.comfy ? (
        <p className="text-xs text-amber-300">ComfyUI isn't running on the PC. Start it with Start-ScheduledTask "Mission Control ComfyUI" in PowerShell.</p>
      ) : !health.aceStep ? (
        <p className="text-xs text-amber-300">
          ACE-Step 1.5 isn't in ComfyUI yet: download ace_step_1.5_turbo_aio.safetensors (Comfy-Org/ace_step_1.5_ComfyUI_files on Hugging Face) into ComfyUI's models/checkpoints folder, or open the ACE-Step 1.5 template in ComfyUI once.
        </p>
      ) : (
        <p className="text-[11px] text-slate-500">Model: {health.aceStep}, on the graphics card.</p>
      )}
      <label className="block text-xs text-slate-400">
        Style
        <textarea value={f.prompt} onChange={(e) => set("prompt", e.target.value)} rows={2} className={`${input} mt-1`} placeholder="soulful R&B, warm Rhodes, brushed drums, female vocals, late night" />
      </label>
      <label className="block text-xs text-slate-400">
        Title
        <input value={f.title} onChange={(e) => set("title", e.target.value)} className={`${input} mt-1`} placeholder="Late Night Signal" />
      </label>
      <label className="block text-xs text-slate-400">
        Lyrics (leave empty for an instrumental). Mark parts with [verse], [chorus], [bridge].
        <textarea value={f.lyrics} onChange={(e) => set("lyrics", e.target.value)} rows={6} className={`${input} mt-1 font-mono text-xs`} placeholder={"[verse]\nCity lights are humming low\n\n[chorus]\nStay with me till the morning"} />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-slate-400">
          Length (s)
          <input type="number" min={10} max={600} value={f.seconds} onChange={(e) => set("seconds", Number(e.target.value))} className={`${input} mt-1 w-24`} />
        </label>
        <label className="text-xs text-slate-400">
          BPM
          <input type="number" min={40} max={220} value={f.bpm} onChange={(e) => set("bpm", Number(e.target.value))} className={`${input} mt-1 w-20`} />
        </label>
        <label className="text-xs text-slate-400">
          Key
          <select value={f.key} onChange={(e) => set("key", e.target.value)} className={`${input} mt-1 w-32`}>
            {KEYS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Time
          <select value={f.timesig} onChange={(e) => set("timesig", e.target.value)} className={`${input} mt-1 w-20`}>
            {["2", "3", "4", "6"].map((t) => (
              <option key={t} value={t}>
                {t}/4
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Language
          <input value={f.language} onChange={(e) => set("language", e.target.value.toLowerCase().slice(0, 7))} className={`${input} mt-1 w-20`} placeholder="en" />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" checked={f.split} onChange={(e) => set("split", e.target.checked)} />
        Split it into stems afterwards (for practice, karaoke and sheet music)
      </label>
      <button disabled={busy || !f.prompt.trim() || !health?.aceStep} onClick={() => void go()} className={primary}>
        Write the song
      </button>
      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}

// --- The page --------------------------------------------------------------------------

export default function StudioPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [outs, setOuts] = useState<Output[]>([]);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<string | null>(null);
  const [mode, setMode] = useState<"music" | "video">("music");
  const load = useCallback(() => {
    Promise.all([getJson<Health>("/api/studio/health"), getJson<{ songs: Song[] }>("/api/studio/songs"), getJson<{ jobs: Job[] }>("/api/studio/jobs"), getJson<{ outputs: Output[] }>("/api/studio/outputs")])
      .then(([h, s, j, o]) => {
        setHealth(h);
        setSongs(s.songs);
        setJobs(j.jobs);
        setOuts(o.outputs);
        setError(null);
        setSelected((x) => x ?? s.songs[0]?.id ?? "new");
      })
      .catch((e) => setError(errText(e)));
  }, []);
  const active = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => {
    load();
    const t = setInterval(load, active ? 2500 : 10000);
    return () => clearInterval(t);
  }, [load, active]);
  const song = useMemo(() => songs.find((s) => s.id === selected), [songs, selected]);

  const addFiles = async (files: FileList | null) => {
    for (const file of [...(files ?? [])]) {
      if (file.size > 100 * 1024 * 1024) {
        setError(`${file.name} is over 100 MB`);
        continue;
      }
      setUpload(`Adding ${file.name}…`);
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
          r.readAsDataURL(file);
        });
        const s = await send<Song>("POST", "/api/studio/songs", { title: file.name.replace(/\.[^.]+$/, ""), filename: file.name, data });
        setSelected(s.id);
      } catch (e) {
        setError(`${file.name}: ${errText(e)}`);
      }
    }
    setUpload(null);
    load();
  };
  const remove = async (s: Song) => {
    if (!confirm(`Remove “${s.title}” and its stems from the library? Finished outputs stay.`)) return;
    try {
      await send("DELETE", `/api/studio/songs/${s.id}`);
      setSelected(null);
      load();
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <div className="col-span-3 min-h-0 flex flex-col md:flex-row gap-4">
      <aside className="md:w-72 shrink-0 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto max-h-72 md:max-h-none">
        <div className="p-3 flex items-center justify-between gap-2">
          <h1 className="text-sm font-semibold text-slate-100">Studio</h1>
          <div className="flex gap-1.5">
            <button onClick={() => setSelected("new")} className={`${quiet} ${selected === "new" ? "border-cyan-700 text-cyan-300" : ""}`}>
              New song
            </button>
            <label className={`${primary} cursor-pointer`}>
              + Add audio
              <input type="file" multiple accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.ogg,.mp4" className="hidden" onChange={(e) => void addFiles(e.target.files)} />
            </label>
          </div>
        </div>
        {upload && <p className="px-3 pb-2 text-xs text-cyan-300">{upload}</p>}
        {songs.map((s) => (
          <button key={s.id} onClick={() => setSelected(s.id)} className={`w-full text-left px-3 py-2.5 border-t border-slate-800/70 ${selected === s.id ? "bg-cyan-950/40" : "hover:bg-slate-900"}`}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm text-slate-200 truncate">{s.title}</span>
              <span className="text-[10px] text-slate-500">{mmss(s.duration)}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {s.status === "ready" ? s.stems.map((x) => <span key={x} className={`h-1.5 w-4 rounded ${STEM_COLOR[x] ?? "bg-slate-500"}`} title={x} />) : <span className={`text-[11px] ${s.status === "failed" ? "text-rose-300" : "text-cyan-300"}`}>{s.status === "failed" ? "split failed" : "splitting…"}</span>}
              <span className="text-[10px] text-slate-600 ml-auto">{s.source === "ace-step" ? "ACE-Step" : s.splitBy === "gpu" ? "GPU" : ""}</span>
            </div>
          </button>
        ))}
        {!songs.length && <p className="px-3 py-2 text-xs text-slate-500">No songs yet: add audio or write a new song.</p>}
      </aside>

      <main className="flex-1 min-w-0 bg-slate-900 border border-slate-800 rounded-xl overflow-y-auto p-4 md:p-6 space-y-6">
        <div className="flex flex-wrap items-center gap-1.5">
          {health ? (
            <>
              <Chip ok={health.comfy} label="ComfyUI (graphics card)" title={health.comfyUrl} />
              <Chip ok={Boolean(health.aceStep)} label="ACE-Step songs" title={health.aceStep ?? "Not installed in ComfyUI"} />
              <Chip ok={health.gpuStems} label={health.gpuStems ? "Stems on the GPU" : "Stems on the CPU"} title="Install tools/comfyui/custom_nodes/mission_control_stems in ComfyUI for the graphics card" />
              <Chip ok={health.musescore} label="MuseScore" />
              <Chip ok={health.voice} label="Lyrics (Whisper)" />
            </>
          ) : (
            !error && <span className="text-xs text-slate-500">Checking the studio…</span>
          )}
        </div>
        {error && <p className="text-xs text-rose-300 rounded border border-rose-900 bg-rose-950/40 px-3 py-2">{error}</p>}

        <div className="flex gap-1.5" role="tablist" aria-label="Studio mode">
          {(["music", "video"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`${btn} border text-sm ${mode === m ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
              {m === "music" ? "♪ Music studio" : "▶ Video studio"}
            </button>
          ))}
        </div>

        {mode === "video" ? (
          <VideoStudio songs={songs} onJob={load} comfy={Boolean(health?.comfy)} voice={Boolean(health?.voice)} stockKeys={health?.stock} />
        ) : selected === "new" ? (
          <NewSong health={health} onJob={load} />
        ) : song ? (
          <section className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-semibold text-slate-100 truncate">{song.title}</h2>
                <p className="text-xs text-slate-500">
                  {mmss(song.duration)} · {song.source === "ace-step" ? `written by ACE-Step${song.bpm ? ` · ${song.bpm} BPM` : ""}${song.key ? ` · ${song.key}` : ""}` : "added by you"}
                  {song.splitBy && ` · split on the ${song.splitBy === "gpu" ? "graphics card" : "CPU"}`}
                </p>
                {song.prompt && <p className="text-[11px] text-slate-500 mt-1">“{song.prompt}”</p>}
              </div>
              <a href={fileUrl(`library/${song.id}/original.wav`, true)} className="text-[11px] text-cyan-400 hover:text-cyan-300">
                Original WAV
              </a>
              <button onClick={() => void remove(song)} className={`${btn} text-slate-500 hover:text-rose-300`}>
                Remove
              </button>
            </div>
            <SongTools key={song.id} song={song} health={health} onJob={load} />
          </section>
        ) : null}

        {jobs.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-slate-200">Jobs</h3>
            {jobs.slice(0, 12).map((j) => (
              <div key={j.id} className="rounded border border-slate-800 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`px-1.5 py-0.5 rounded ${j.status === "done" ? "bg-emerald-950 text-emerald-300" : j.status === "failed" ? "bg-rose-950 text-rose-300" : j.status === "running" ? "bg-cyan-950 text-cyan-300" : "bg-slate-800 text-slate-400"}`}>{j.status}</span>
                  <span className="flex-1 text-slate-200 truncate">{j.title}</span>
                  {(j.status === "queued" || j.status === "running") && (
                    <button onClick={() => void send("POST", `/api/studio/jobs/${j.id}/cancel`).then(load, (e) => setError(errText(e)))} className="text-[11px] text-slate-500 hover:text-rose-300">
                      Cancel
                    </button>
                  )}
                </div>
                {j.status === "running" && j.progress && <p className="text-[11px] text-cyan-300">{j.progress}…</p>}
                {j.error && <p className="text-[11px] text-rose-300">{j.error}</p>}
                {j.result && (
                  <div className="space-y-1">
                    <p className="text-[11px] text-slate-400">{j.result.message}</p>
                    {j.type !== "split" && j.result.files.map((f) => <FileLink key={f} rel={f} />)}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {outs.length > 0 && (
          <details className="space-y-2">
            <summary className="text-sm font-medium text-slate-200 cursor-pointer">All outputs ({outs.length})</summary>
            {outs.map((o) => (
              <div key={`${o.kind}/${o.name}`} className="rounded border border-slate-800 p-2.5 space-y-1">
                <p className="text-xs text-slate-300">
                  <span className="text-[10px] uppercase text-slate-500 mr-2">{o.kind}</span>
                  {o.name}
                </p>
                {o.files.map((f) => (
                  <FileLink key={f} rel={f} />
                ))}
              </div>
            ))}
            <p className="text-[11px] text-slate-500">Also on the PC in mission-control/data/studio/outputs.</p>
          </details>
        )}
      </main>
    </div>
  );
}
