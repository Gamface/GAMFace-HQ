import { useState } from "react";
import { AGENT_LABELS, defaultPrompt, send } from "../api";
import AudioAttach, { useAudioUploads } from "./AudioAttach";
import DocAttach, { useDocUploads } from "./DocAttach";
import ImageAttach, { imageFiles, useImageUploads } from "./ImageAttach";

// Reply to a finished card. The same agent picks the conversation back up with the
// earlier turns as history (or pick another agent, or let the router choose).

const TARGETS = ["same", "auto", "planner", "coder", "browser", "file", "security_audit", "vision", "tools"] as const;

export default function ReplyBox({ taskId, agent, onSent, compact }: { taskId: string; agent?: string; onSent?: () => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState<(typeof TARGETS)[number]>("same");
  const [images, setImages] = useState<string[]>([]);
  const [audio, setAudio] = useState<string[]>([]);
  const imgUp = useImageUploads(images, setImages);
  const audUp = useAudioUploads(audio, setAudio);
  const [documents, setDocuments] = useState<string[]>([]);
  const docUp = useDocUploads(documents, setDocuments);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAttach, setShowAttach] = useState(false);

  const canSend = (text.trim() || audio.length || documents.length) && !busy && !imgUp.busy && !audUp.busy && !docUp.busy;
  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/api/tasks/${taskId}/reply`, {
        message: text.trim() || defaultPrompt(audio.length, documents.length),
        images,
        audio,
        documents,
        targetAgent: to,
      });
      setText("");
      setImages([]);
      setAudio([]);
      setDocuments([]);
      setShowAttach(false);
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`border-t border-slate-800 bg-slate-950/60 space-y-2 ${compact ? "p-2" : "px-4 py-3"}`}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
        }}
        onPaste={(e) => {
          const files = imageFiles(e.clipboardData?.items);
          if (files.length) {
            e.preventDefault();
            setShowAttach(true);
            void imgUp.add(files);
          }
        }}
        rows={compact ? 2 : 3}
        placeholder={`Reply to ${agent ? AGENT_LABELS[agent] ?? agent : "the agent"} (Ctrl+Enter). It continues this conversation.`}
        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-200 resize-none focus:outline-none focus:border-cyan-500"
      />
      {showAttach && (
        <div className="space-y-1.5">
          <ImageAttach value={images} onChange={setImages} uploader={imgUp} compact />
          <AudioAttach value={audio} onChange={setAudio} uploader={audUp} compact />
          <DocAttach value={documents} onChange={setDocuments} uploader={docUp} compact />
        </div>
      )}
      <div className="flex items-center gap-2 text-xs">
        <button type="button" onClick={() => setShowAttach((v) => !v)} className="text-slate-400 hover:text-cyan-300">
          📎 {showAttach ? "Hide attachments" : "Attach"}
          {images.length + audio.length + documents.length > 0 ? ` (${images.length + audio.length + documents.length})` : ""}
        </button>
        <label className="flex items-center gap-1 text-slate-500 ml-auto">
          To
          <select value={to} onChange={(e) => setTo(e.target.value as typeof to)} className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-slate-200">
            {TARGETS.map((t) => (
              <option key={t} value={t}>
                {t === "same" ? `Same agent${agent ? ` (${AGENT_LABELS[agent] ?? agent})` : ""}` : AGENT_LABELS[t] ?? t}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSend}
          className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-400 text-white font-medium"
        >
          {busy ? "Sending…" : "Reply"}
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-300">{error}</p>}
    </div>
  );
}
