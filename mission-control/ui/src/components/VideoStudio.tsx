import { useCallback, useEffect, useState } from "react";
import { getJson, send } from "../api";

// The video half of the Studio page: Jarvis Studio's video workflows. Songs come from the music
// library; clips, photos and recordings are uploaded into media folders.

interface SongLite {
  id: string;
  title: string;
  status: string;
  duration?: number;
}

interface MediaFolder {
  folder: string;
  files: { name: string; path: string; bytes: number }[];
}

type Flow = "music_video" | "shorts" | "beat_edit" | "narrated" | "explainer" | "captions" | "performance";

const FLOWS: { key: Flow; label: string; what: string }[] = [
  { key: "music_video", label: "Music video", what: "A moving waveform lane per part, a spectrum or one big waveform, with a title card, lyrics and a thumbnail." },
  { key: "shorts", label: "Shorts", what: "9:16, 1:1 and 16:9 clips of a song (its loudest part) or of your video, with captions and -14 LUFS audio. Never posts." },
  { key: "beat_edit", label: "Beat-cut edit", what: "A folder of your clips and photos cut every 2, 4 or 8 beats of a song, plus an .otio timeline for Kdenlive." },
  { key: "narrated", label: "Narrated video", what: "Kokoro reads your script, one slide or photo per paragraph, captions from the script, music ducked under the voice." },
  { key: "explainer", label: "Explainer", what: "Any length, scene by scene: a picture per scene from ComfyUI on the graphics card, chapter cards, animated captions, YouTube chapters." },
  { key: "captions", label: "Captions", what: "Whisper subtitles (.srt) for any video, optionally burned into the picture." },
  { key: "performance", label: "Performance", what: "Your recorded take (from OBS or a phone) lined up with the studio backing, mixed, with lyrics." },
];

const STYLES = ["cinematic", "documentary", "3d cartoon", "anime", "watercolor storybook", "comic", "claymation", "pencil sketch", "flat", "retro vhs", "whiteboard", "social"];
const VOICES = ["af_heart", "af_bella", "af_nicole", "am_michael", "am_adam", "bf_emma", "bm_george", "bm_lewis"];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\d+ /, "").replace(/^\{"error":"(.*)"\}$/, "$1");
const input = "w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
const btn = "px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50";
const primary = `${btn} bg-cyan-600 hover:bg-cyan-500 text-white`;
const quiet = `${btn} border border-slate-700 text-slate-300 hover:bg-slate-800`;
const isVideo = (n: string) => /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(n);
const isAudio = (n: string) => /\.(wav|mp3|m4a|flac|ogg)$/i.test(n);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-slate-400">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

export default function VideoStudio({ songs, onJob, comfy, voice }: { songs: SongLite[]; onJob: () => void; comfy: boolean; voice: boolean }) {
  const ready = songs.filter((s) => s.status === "ready");
  const [flow, setFlow] = useState<Flow>("music_video");
  const [media, setMedia] = useState<MediaFolder[]>([]);
  const [f, setF] = useState<Record<string, unknown>>({ aspect: "16:9", style: "stems", lyrics: true, pace: "medium", platforms: ["shorts", "square"], length: 30, caption: "auto", voice: "af_heart", burn: true, capstyle: "bottom", exstyle: "cinematic" });
  const [folder, setFolder] = useState("my-clips");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const loadMedia = useCallback(() => {
    getJson<{ media: MediaFolder[] }>("/api/studio/media")
      .then((r) => setMedia(r.media))
      .catch(() => {});
  }, []);
  useEffect(loadMedia, [loadMedia]);

  const upload = async (files: FileList | null) => {
    setMsg(null);
    for (const file of [...(files ?? [])]) {
      if (file.size > 200 * 1024 * 1024) {
        setMsg(`${file.name} is over 200 MB`);
        continue;
      }
      setMsg(`Uploading ${file.name}…`);
      try {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error(`Couldn't read ${file.name}`));
          r.readAsDataURL(file);
        });
        await send("POST", "/api/studio/media", { folder, filename: file.name, data });
      } catch (e) {
        setMsg(`${file.name}: ${errText(e)}`);
        return;
      }
    }
    setMsg("Uploaded.");
    loadMedia();
  };

  const s = (k: string) => String(f[k] ?? "");
  const num = (k: string) => (f[k] === "" || f[k] === undefined ? undefined : Number(f[k]));
  const body = (): Record<string, unknown> => {
    switch (flow) {
      case "music_video":
        return { type: flow, song: s("song"), style: s("style"), aspect: s("aspect"), title: s("title") || undefined, lyrics: Boolean(f.lyrics), start: num("start"), end: num("end"), background: s("background") || undefined };
      case "shorts":
        return { type: flow, source: s("source") || undefined, song: s("song") || undefined, platforms: f.platforms, length: num("length") ?? 30, start: num("start"), caption: s("caption"), title: s("title") || undefined };
      case "beat_edit":
        return { type: flow, media: s("mediaFolder"), song: s("song"), aspect: s("aspect"), pace: s("pace"), title: s("title") || undefined, start: num("start"), max_len: num("maxLen"), lyrics: Boolean(f.lyrics) };
      case "narrated":
        return { type: flow, script: s("script"), title: s("title") || "Narrated video", media: s("mediaFolder") || undefined, voice: s("voice"), music: s("song") || undefined, aspect: s("aspect"), voice_speed: num("speed") ?? 1 };
      case "explainer":
        return { type: flow, title: s("title"), script: s("script"), aspect: s("aspect"), voice: s("voice"), music: s("song") || undefined, style: s("exstyle"), voice_speed: num("speed") ?? 1 };
      case "captions":
        return { type: flow, video: s("source"), style: s("capstyle"), burn: Boolean(f.burn) };
      case "performance":
        return { type: flow, recording: s("source"), song: s("song"), lyrics: Boolean(f.lyrics) };
    }
  };
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await send("POST", "/api/studio/jobs", JSON.parse(JSON.stringify(body())));
      setMsg("Started: see Jobs below. Videos render on the CPU; a minute of video takes a few minutes.");
      onJob();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const songPick = (label = "Song", optional = false) => (
    <Field label={label}>
      <select value={s("song")} onChange={(e) => set("song", e.target.value)} className={input}>
        <option value="">{optional ? "None" : "Pick a song (split into stems)"}</option>
        {ready.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </select>
    </Field>
  );
  const folderPick = (label: string, optional = false) => (
    <Field label={label}>
      <select value={s("mediaFolder")} onChange={(e) => set("mediaFolder", e.target.value)} className={input}>
        <option value="">{optional ? "None (generated slides)" : "Pick a media folder"}</option>
        {media.map((m) => (
          <option key={m.folder} value={`media/${m.folder}`}>
            {m.folder} ({m.files.length} files)
          </option>
        ))}
      </select>
    </Field>
  );
  const filePick = (label: string, test: (n: string) => boolean, optional = false) => (
    <Field label={label}>
      <select value={s("source")} onChange={(e) => set("source", e.target.value)} className={input}>
        <option value="">{optional ? "None: use the song" : "Pick an uploaded file"}</option>
        {media.flatMap((m) =>
          m.files
            .filter((x) => test(x.name))
            .map((x) => (
              <option key={x.path} value={x.path}>
                {m.folder}/{x.name}
              </option>
            )),
        )}
      </select>
    </Field>
  );
  const aspectPick = (
    <Field label="Shape">
      <select value={s("aspect")} onChange={(e) => set("aspect", e.target.value)} className={input}>
        <option value="16:9">16:9 (YouTube)</option>
        <option value="9:16">9:16 (Shorts, Reels, TikTok)</option>
        <option value="1:1">1:1 (square)</option>
      </select>
    </Field>
  );
  const ok =
    flow === "music_video" ? Boolean(f.song) : flow === "shorts" ? Boolean(f.source || f.song) : flow === "beat_edit" ? Boolean(f.song && f.mediaFolder) : flow === "narrated" ? s("script").trim().length >= 10 : flow === "explainer" ? Boolean(s("title").trim() && s("script").trim().length >= 20) : flow === "captions" ? Boolean(f.source) : Boolean(f.source && f.song);
  const needsVoice = flow === "narrated" || flow === "explainer" || flow === "captions";

  return (
    <div className="space-y-5">
      <section className="rounded border border-slate-800 p-3 space-y-2">
        <h3 className="text-sm font-medium text-slate-200">Your media</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input value={folder} onChange={(e) => setFolder(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40))} className={`${input} w-44`} aria-label="Folder" />
          <label className={`${quiet} cursor-pointer`}>
            Upload clips, photos or recordings
            <input type="file" multiple accept="video/*,image/*,audio/*,.txt" className="hidden" onChange={(e) => void upload(e.target.files)} />
          </label>
          <span className="text-[11px] text-slate-500">Up to 200 MB each. A beat-cut edit uses a whole folder.</span>
        </div>
        {media.length > 0 && (
          <ul className="text-[11px] text-slate-400 space-y-0.5">
            {media.map((m) => (
              <li key={m.folder}>
                <span className="text-slate-300">{m.folder}</span>: {m.files.map((x) => x.name).join(", ")}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-wrap gap-1.5">
        {FLOWS.map((x) => (
          <button key={x.key} onClick={() => setFlow(x.key)} className={`${btn} border ${flow === x.key ? "border-cyan-600 bg-cyan-950 text-cyan-300" : "border-slate-700 text-slate-400 hover:bg-slate-800"}`}>
            {x.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-400">{FLOWS.find((x) => x.key === flow)!.what}</p>
      {needsVoice && !voice && <p className="text-xs text-amber-300">This needs the voice service (Kokoro and Whisper).</p>}
      {flow === "explainer" && !comfy && <p className="text-xs text-amber-300">Pictures come from ComfyUI, which isn't running: start it first.</p>}

      <div className="grid sm:grid-cols-2 gap-3 max-w-3xl">
        {flow === "music_video" && (
          <>
            {songPick()}
            <Field label="Look">
              <select value={s("style")} onChange={(e) => set("style", e.target.value)} className={input}>
                <option value="stems">A lane per part</option>
                <option value="spectrum">Spectrum bars</option>
                <option value="waves">One big waveform</option>
              </select>
            </Field>
            {aspectPick}
            <Field label="Title (optional)">
              <input value={s("title")} onChange={(e) => set("title", e.target.value)} className={input} />
            </Field>
            <Field label="From / to (seconds, optional)">
              <div className="flex gap-2">
                <input value={s("start")} onChange={(e) => set("start", e.target.value)} className={input} placeholder="0" inputMode="decimal" />
                <input value={s("end")} onChange={(e) => set("end", e.target.value)} className={input} placeholder="end" inputMode="decimal" />
              </div>
            </Field>
            {filePick("Background picture (optional)", (n) => /\.(png|jpe?g|webp)$/i.test(n), true)}
          </>
        )}
        {flow === "shorts" && (
          <>
            {filePick("Your video (or leave empty and pick a song)", isVideo, true)}
            {songPick("Song", true)}
            <Field label="Platforms">
              <div className="flex flex-wrap gap-2">
                {["shorts", "reels", "tiktok", "square", "youtube"].map((pl) => (
                  <label key={pl} className="flex items-center gap-1 text-slate-300">
                    <input type="checkbox" checked={(f.platforms as string[]).includes(pl)} onChange={(e) => set("platforms", e.target.checked ? [...(f.platforms as string[]), pl] : (f.platforms as string[]).filter((x) => x !== pl))} />
                    {pl}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Length (seconds)">
              <input value={s("length")} onChange={(e) => set("length", e.target.value)} className={input} inputMode="decimal" />
            </Field>
            <Field label="Captions">
              <select value={s("caption")} onChange={(e) => set("caption", e.target.value)} className={input}>
                <option value="auto">Automatic (lyrics or speech)</option>
                <option value="lyrics">Lyrics</option>
                <option value="speech">Speech (Whisper)</option>
                <option value="none">None</option>
              </select>
            </Field>
          </>
        )}
        {flow === "beat_edit" && (
          <>
            {folderPick("Clips and photos")}
            {songPick()}
            {aspectPick}
            <Field label="Pace">
              <select value={s("pace")} onChange={(e) => set("pace", e.target.value)} className={input}>
                <option value="fast">Fast (every 2 beats)</option>
                <option value="medium">Medium (every 4)</option>
                <option value="slow">Slow (every 8)</option>
              </select>
            </Field>
            <Field label="Longest (seconds, optional)">
              <input value={s("maxLen")} onChange={(e) => set("maxLen", e.target.value)} className={input} placeholder="the whole song" inputMode="decimal" />
            </Field>
          </>
        )}
        {(flow === "narrated" || flow === "explainer") && (
          <>
            <Field label="Title">
              <input value={s("title")} onChange={(e) => set("title", e.target.value)} className={input} />
            </Field>
            <Field label="Voice (Kokoro)">
              <select value={s("voice")} onChange={(e) => set("voice", e.target.value)} className={input}>
                {VOICES.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </Field>
            <div className="sm:col-span-2">
              <Field label={flow === "explainer" ? "Script: one paragraph per scene; lines starting with # are chapters" : "Script: one paragraph per slide"}>
                <textarea value={s("script")} onChange={(e) => set("script", e.target.value)} rows={8} className={`${input} font-mono text-xs`} />
              </Field>
            </div>
            {flow === "narrated" ? folderPick("Photos or clips (optional)", true) : (
              <Field label="Look">
                <select value={s("exstyle")} onChange={(e) => set("exstyle", e.target.value)} className={input}>
                  {STYLES.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </Field>
            )}
            {songPick("Music under the voice", true)}
            {aspectPick}
            <Field label="Voice speed">
              <input type="number" min={0.5} max={2} step={0.05} value={s("speed") || "1"} onChange={(e) => set("speed", e.target.value)} className={input} />
            </Field>
          </>
        )}
        {flow === "captions" && (
          <>
            {filePick("Video", isVideo)}
            <Field label="Look">
              <select value={s("capstyle")} onChange={(e) => set("capstyle", e.target.value)} className={input}>
                <option value="bottom">Bottom</option>
                <option value="pop">Pop</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input type="checkbox" checked={Boolean(f.burn)} onChange={(e) => set("burn", e.target.checked)} />
              Also make a copy with the captions in the picture
            </label>
          </>
        )}
        {flow === "performance" && (
          <>
            {filePick("Your recording", (n) => isVideo(n) || isAudio(n))}
            {songPick("The song you performed")}
          </>
        )}
        {(flow === "music_video" || flow === "beat_edit" || flow === "performance") && (
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={Boolean(f.lyrics)} onChange={(e) => set("lyrics", e.target.checked)} />
            Lyrics on screen (Whisper listens to the vocals once)
          </label>
        )}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={busy || !ok} onClick={() => void go()} className={primary}>
          Make it
        </button>
        {msg && <p className="text-xs text-slate-400">{msg}</p>}
      </div>
      {flow === "explainer" && <p className="text-[11px] text-slate-500">Each scene's voice, picture and clip are kept, so changing one scene and making it again only redoes that scene.</p>}
    </div>
  );
}
