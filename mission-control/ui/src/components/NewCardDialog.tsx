import { useEffect, useState } from "react";
import { useProjects } from "../project";
import type { ReactNode } from "react";
import { AGENT_LABELS, getJson, send } from "../api";
import type { BoardCard } from "../api";
import ImageAttach, { imageFiles, useImageUploads } from "./ImageAttach";
import AudioAttach, { useAudioUploads } from "./AudioAttach";
import DocAttach, { useDocUploads } from "./DocAttach";
import { defaultPrompt } from "../api";

// Form for a new card (also reused for editing a card in Backlog or Ready).

export interface CardFields {
  title: string;
  prompt: string;
  targetAgent: string;
  priority: "low" | "normal" | "high";
  dependsOn: string[];
  needsReview: boolean;
  readOnly: boolean;
  allowedSites: string[];
  images: string[];
  audio: string[];
  documents: string[];
  // Browser profile ("" = the default); read-only runs never use one
  profile?: string;
  // Project (null: General)
  project?: string | null;
  // The Coder and File agents may edit the project's workspace
  workspace?: boolean;
}

/** The browser profiles a project's cards may use (its own and shared ones), for a picker. */
function useProfileNames(project: string | null | undefined): { names: string[]; def: string } {
  const [state, setState] = useState<{ profiles: { name: string; project?: string | null }[]; def: string }>({ profiles: [], def: "" });
  useEffect(() => {
    getJson<{ profiles: { name: string; project?: string | null }[]; default: string }>("/api/profiles")
      .then((d) => setState({ profiles: d.profiles, def: d.default }))
      .catch(() => {});
  }, []);
  return { names: state.profiles.filter((p) => !p.project || p.project === (project ?? null)).map((p) => p.name), def: state.def };
}

export function CardForm({
  initial,
  cards,
  selfId,
  submitLabel,
  onSubmit,
  onCancel,
  extra,
}: {
  initial: CardFields;
  cards: BoardCard[];
  selfId?: string;
  submitLabel: string;
  onSubmit: (f: CardFields) => Promise<void>;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  const [f, setF] = useState<CardFields>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof CardFields>(k: K, v: CardFields[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const profileNames = useProfileNames(f.project);
  const proj = useProjects();
  const uploader = useImageUploads(f.images, (ids) => set("images", ids));
  const audioUp = useAudioUploads(f.audio, (ids) => set("audio", ids));
  const docUp = useDocUploads(f.documents, (ids) => set("documents", ids));
  const candidates = cards.filter((c) => c.id !== selfId && c.column !== "failed").sort((a, b) => b.createdAt - a.createdAt);

  const submit = async () => {
    if (!f.prompt.trim() && !f.audio.length && !f.documents.length) return setError("Describe the task.");
    if (uploader.busy || audioUp.busy || docUp.busy) return setError("Wait for the attachments to finish uploading.");
    setBusy(true);
    try {
      const ready = f.prompt.trim() ? f : { ...f, prompt: defaultPrompt(f.audio.length, f.documents.length) };
      await onSubmit({ ...ready, profile: ready.profile || undefined, project: ready.project ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const input = "w-full bg-slate-950 border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-cyan-500";
  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs text-slate-400">Title (optional)</span>
        <input className={input} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Short name for the card" maxLength={200} />
      </label>
      <label className="block">
        <span className="text-xs text-slate-400">Task</span>
        <textarea
          className={`${input} h-28 resize-y font-mono text-[13px]`}
          value={f.prompt}
          onChange={(e) => set("prompt", e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
          }}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData?.items);
            if (files.length) {
              e.preventDefault();
              void uploader.add(files);
            }
          }}
          placeholder="What should the agent do? (Ctrl+Enter to save; paste pictures here)"
          autoFocus
        />
      </label>
      <ImageAttach value={f.images} onChange={(ids) => set("images", ids)} uploader={uploader} />
      <AudioAttach value={f.audio} onChange={(ids) => set("audio", ids)} uploader={audioUp} />
      <DocAttach value={f.documents} onChange={(ids) => set("documents", ids)} uploader={docUp} />
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-400">Agent</span>
          <select className={input} value={f.targetAgent} onChange={(e) => set("targetAgent", e.target.value)}>
            {["auto", "planner", "coder", "browser", "file", "security_audit", "vision", "tools"].map((k) => (
              <option key={k} value={k}>
                {AGENT_LABELS[k]}
                {k === "planner" ? " (can delegate)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-slate-400">Priority</span>
          <select className={input} value={f.priority} onChange={(e) => set("priority", e.target.value as CardFields["priority"])}>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-xs text-slate-400">Waits for (runs only after these are done)</span>
        <select
          multiple
          className={`${input} h-24`}
          value={f.dependsOn}
          onChange={(e) => set("dependsOn", [...e.target.selectedOptions].map((o) => o.value).slice(0, 10))}
        >
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              [{c.column}] {c.title || c.prompt.slice(0, 60)}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-slate-600">Ctrl/Cmd-click to pick several.</span>
      </label>
      <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
        <input type="checkbox" checked={f.needsReview} onChange={(e) => set("needsReview", e.target.checked)} />
        I'll review the result before it counts as done
      </label>
      <div>
        <label className="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={f.readOnly} onChange={(e) => set("readOnly", e.target.checked)} />
          Read-only run: look, don't touch
        </label>
        {f.readOnly && (
          <div className="ml-6 mt-1.5 space-y-1">
            <input
              className={input}
              value={f.allowedSites.join(", ")}
              onChange={(e) =>
                set(
                  "allowedSites",
                  e.target.value
                    .split(/[\s,]+/)
                    .map((x) => x.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
                    .filter(Boolean)
                    .slice(0, 10),
                )
              }
              placeholder="Sites it may open, e.g. example.com (blank: sites named in the task)"
            />
            <p className="text-[10px] text-slate-500">
              Fresh browser profile (never logged in), links only on these sites, no typing, buttons or form submits, no notes or memories saved.
            </p>
          </div>
        )}
        {!f.readOnly && profileNames.names.length > 0 && (
          <label className="ml-6 mt-1.5 flex items-center gap-2 text-xs text-slate-400">
            Browse signed in as
            <select className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200" value={f.profile ?? ""} onChange={(e) => set("profile", e.target.value)}>
              <option value="">{profileNames.def} (default)</option>
              {profileNames.names
                .filter((n) => n !== profileNames.def)
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
            <span className="text-[10px] text-slate-500">browser profile; typing, submits and buttons still ask you first</span>
          </label>
        )}
      </div>
      {!f.readOnly && (
        <label className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer select-none">
          <input type="checkbox" className="mt-0.5" checked={Boolean(f.workspace)} onChange={(e) => set("workspace", e.target.checked)} />
          <span>
            Edit files in the workspace{" "}
            <span className="text-slate-500">
              (“{proj.byId(f.project)?.workspace || f.project || "general"}”): the Coder and File agents may create, change and delete files there. Every change can be undone from the card or the Files page.
            </span>
          </span>
        </label>
      )}
      {(proj.active.length > 0 || f.project) && (
        <label className="flex items-center gap-2 text-xs text-slate-400">
          Project
          <select
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
            value={f.project ?? ""}
            onChange={(e) => setF((prev) => ({ ...prev, project: e.target.value || null, profile: undefined }))}
          >
            <option value="">General</option>
            {proj.projects
              .filter((p) => !p.archived || p.id === f.project)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.localOnly ? "🔒 " : ""}
                  {p.name}
                </option>
              ))}
          </select>
          {proj.byId(f.project)?.localOnly && <span className="text-[10px] text-emerald-300">local models only</span>}
        </label>
      )}
      {extra}
      {error && <p className="text-rose-300 text-xs">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md bg-slate-800 text-slate-300 hover:bg-slate-700">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={busy} className="px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white font-medium disabled:opacity-50">
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </div>
  );
}

export default function NewCardDialog({
  column,
  cards,
  onClose,
  onCreated,
}: {
  column: "backlog" | "ready";
  cards: BoardCard[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [where, setWhere] = useState(column);
  const { target } = useProjects();
  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-xl p-5 shadow-2xl">
        <h2 className="text-base font-semibold text-slate-100 mb-3">New card</h2>
        <CardForm
          initial={{ title: "", prompt: "", targetAgent: "auto", priority: "normal", dependsOn: [], needsReview: false, readOnly: false, allowedSites: [], images: [], audio: [], documents: [], project: target }}
          cards={cards}
          submitLabel={where === "ready" ? "Add & queue" : "Add to Backlog"}
          onCancel={onClose}
          onSubmit={async (f) => {
            await send("POST", "/api/tasks", { ...f, title: f.title || undefined, column: where });
            onCreated();
          }}
          extra={
            <div className="flex gap-4 text-slate-300">
              {(["ready", "backlog"] as const).map((w) => (
                <label key={w} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="radio" checked={where === w} onChange={() => setWhere(w)} />
                  {w === "ready" ? "Queue now (Ready)" : "Park in Backlog"}
                </label>
              ))}
            </div>
          }
        />
      </div>
    </div>
  );
}
