import { useEffect, useRef, useState } from "react";
import { uploadAudio, uploadUrl } from "../api";
import { formatSeconds } from "../audio";

// Attach audio by picking or dropping a file, or record from the microphone.
// Everything is converted to 16 kHz mono WAV in the browser, transcribed on your
// PC by the Transcriber (gemma4:12b by default), and the transcript goes to the agent.

export const MAX_CLIPS = 4;

export function audioFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("audio/") || /\.(mp3|m4a|wav|ogg|oga|opus|webm|flac|aac)$/i.test(f.name));
}

export function useAudioUploads(value: string[], onChange: (ids: string[]) => void) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lengths, setLengths] = useState<Record<string, number>>({});
  const add = async (files: Blob[]) => {
    if (!files.length) return;
    const room = MAX_CLIPS - value.length;
    if (room <= 0) return setError(`At most ${MAX_CLIPS} audio clips per card`);
    setError(null);
    setBusy((n) => n + 1);
    try {
      const ids: string[] = [];
      for (const f of files.slice(0, room)) {
        const out = await uploadAudio(f);
        ids.push(out.id);
        setLengths((l) => ({ ...l, [out.id]: out.seconds }));
      }
      onChange([...new Set([...value, ...ids])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((n) => n - 1);
    }
  };
  return { add, busy: busy > 0, error, lengths };
}

function Recorder({ onDone, disabled }: { onDone: (blob: Blob) => void; disabled: boolean }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const chunks = useRef<Blob[]>([]);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [rec]);
  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onDone(new Blob(chunks.current, { type: r.mimeType || "audio/webm" }));
        setRec(null);
      };
      r.start();
      setElapsed(0);
      setRec(r);
    } catch {
      setError("Microphone not available (check the browser's permission)");
    }
  };
  return (
    <>
      {rec ? (
        <button type="button" onClick={() => rec.stop()} className="text-[11px] text-rose-300 hover:text-rose-200 flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> Stop {formatSeconds(elapsed)}
        </button>
      ) : (
        <button type="button" disabled={disabled} onClick={() => void start()} className="text-[11px] text-slate-400 hover:text-cyan-300 disabled:opacity-40">
          🎙 Record
        </button>
      )}
      {error && <span className="text-[11px] text-rose-300">{error}</span>}
    </>
  );
}

export default function AudioAttach({
  value,
  onChange,
  uploader,
  compact,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  uploader: ReturnType<typeof useAudioUploads>;
  compact?: boolean;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const files = audioFiles(e.dataTransfer?.files);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void uploader.add(files);
      }}
      className={`rounded-md border border-dashed ${over ? "border-cyan-500 bg-cyan-950/30" : "border-slate-700"} ${compact ? "p-1.5" : "p-2"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {value.map((id, i) => (
          <div key={id} className="flex items-center gap-1 bg-slate-950 border border-slate-700 rounded px-1.5 py-1">
            <span className="text-[11px] text-slate-400">🎧 {uploader.lengths[id] !== undefined ? formatSeconds(uploader.lengths[id]) : `clip ${i + 1}`}</span>
            <audio src={uploadUrl(id)} controls preload="none" className="h-6 w-40" />
            <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} className="text-[10px] text-slate-500 hover:text-rose-300" title="Remove audio">
              ✕
            </button>
          </div>
        ))}
        {value.length < MAX_CLIPS && (
          <>
            <label className={`cursor-pointer text-slate-400 hover:text-cyan-300 ${compact ? "text-[11px]" : "text-xs"}`}>
              <input
                type="file"
                accept="audio/*,.mp3,.m4a,.wav,.ogg,.opus,.webm,.flac,.aac"
                multiple
                className="hidden"
                onChange={(e) => {
                  void uploader.add(audioFiles(e.target.files));
                  e.target.value = "";
                }}
              />
              🎧 {value.length ? "Add audio" : compact ? "Attach audio" : "Attach audio: pick or drop a file"}
            </label>
            <Recorder onDone={(blob) => void uploader.add([blob])} disabled={uploader.busy} />
          </>
        )}
        {uploader.busy && <span className="text-[11px] text-slate-500">converting & uploading…</span>}
      </div>
      {uploader.error && <p className="text-[11px] text-rose-300 mt-1">{uploader.error}</p>}
      {value.length > 0 && !compact && (
        <p className="text-[10px] text-slate-500 mt-1">Transcribed on your PC first; the transcript goes to the agent. Audio never goes to a cloud model unless you allow it.</p>
      )}
    </div>
  );
}
