import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { AGENT_COLORS, AGENT_LABELS, getJson, send } from "../api";
import type { PlanState } from "../../../src/hq/plans";
import PlanReview from "./PlanReview";

// Decision Inbox: everything waiting on you, from every card, in one place.
//   Questions   — an agent made its best guess, finished, and asked you something
//   To review   — plans waiting for your markup, and results you said you'd check
//   Finished    — what the team got done lately
// Answering never blocks anyone: the answer goes back to its card as a reply.

interface InboxQuestion {
  id: string;
  code: string;
  taskId: string;
  taskTitle: string;
  agent: string;
  question: string;
  options: string[];
  createdAt: number;
  taskStatus?: string;
}

interface InboxCard {
  id: string;
  title: string;
  agent: string;
  status: string;
  finishedAt?: number;
  preview: string;
}

type ReviewItem = InboxCard & ({ kind: "plan"; plan: PlanState } | { kind: "result" });

interface Inbox {
  questions: InboxQuestion[];
  review: ReviewItem[];
  finished: InboxCard[];
  approvals: number;
  count: number;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const RUNNING = ["queued", "routing", "thinking", "delegating", "streaming", "executing_tool", "writing_diff"];

function ago(at?: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function Agent({ agent }: { agent: string }) {
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${AGENT_COLORS[agent] ?? "bg-slate-700 text-slate-200"}`}>{AGENT_LABELS[agent] ?? agent}</span>;
}

function Section({ title, count, hint, children }: { title: string; count: number; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs uppercase tracking-wider text-slate-400 font-semibold">{title}</h2>
        <span className={`text-[11px] px-1.5 rounded-full ${count ? "bg-cyan-900 text-cyan-200" : "bg-slate-800 text-slate-500"}`}>{count}</span>
        <span className="text-[11px] text-slate-600 truncate">{hint}</span>
      </div>
      {children}
    </section>
  );
}

function QuestionCard({ q, onDone }: { q: InboxQuestion; onDone: () => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const open = q.options.length === 0;
  const answer = open || choice === "__other" ? other.trim() : choice;
  const submit = async () => {
    if (!answer) return;
    setBusy(true);
    setError(null);
    try {
      const out = await send<{ delivered: boolean; reason?: string }>("POST", `/api/inbox/questions/${q.id}`, { answer, note: note.trim() || undefined });
      if (out.delivered) onDone();
      else setSent(out.reason ?? "Saved.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      await send("POST", `/api/inbox/questions/${q.id}/dismiss`);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  if (sent)
    return (
      <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">
        ✓ Answered “{answer}”. {sent}
      </div>
    );
  return (
    <div className="rounded-lg border border-cyan-800/60 bg-slate-900 p-3 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Agent agent={q.agent} />
        <span className="truncate max-w-[60%]">Card: {q.taskTitle}</span>
        <span>· {ago(q.createdAt)}</span>
        {q.taskStatus && RUNNING.includes(q.taskStatus) && <span className="text-amber-300">· card is busy; it gets your answer when it finishes</span>}
      </div>
      <p className="text-[15px] text-slate-100">{q.question}</p>
      {!open && (
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Options">
          {[...q.options, "__other"].map((o) => (
            <button
              key={o}
              role="radio"
              aria-checked={choice === o}
              onClick={() => setChoice(o)}
              className={`px-3 py-1.5 rounded-full text-sm border ${choice === o ? "bg-cyan-600 border-cyan-500 text-white" : "bg-slate-950 border-slate-700 text-slate-200 hover:border-slate-500"}`}
            >
              {o === "__other" ? "Something else…" : o}
            </button>
          ))}
        </div>
      )}
      {(open || choice === "__other") && (
        <input
          autoFocus={choice === "__other"}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="Your answer"
          className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100"
        />
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" className="w-full bg-slate-950 border border-slate-800 rounded-md px-3 py-1.5 text-xs text-slate-200" />
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex items-center gap-2">
        <button disabled={busy || !answer} onClick={() => void submit()} className="px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-medium disabled:opacity-40">
          Send
        </button>
        <button disabled={busy} onClick={() => void dismiss()} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs">
          Dismiss
        </button>
        <span className="ml-auto text-[10px] text-slate-600">code {q.code}</span>
      </div>
    </div>
  );
}

function ReviewRow({ item, onDone }: { item: ReviewItem; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      await send("POST", `/api/tasks/${item.id}/accept`);
      onDone();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  const revising = item.kind === "plan" && item.plan.status === "revising";
  return (
    <div className={`rounded-lg border bg-slate-900 ${item.kind === "plan" ? "border-violet-800/60" : "border-fuchsia-800/50"}`}>
      <button onClick={() => !revising && setOpen((v) => !v)} className="w-full text-left p-3 flex flex-wrap items-center gap-2" aria-expanded={open}>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${item.kind === "plan" ? "bg-violet-800 text-violet-100" : "bg-fuchsia-900 text-fuchsia-100"}`}>
          {item.kind === "plan" ? `PLAN v${item.plan.version}` : "RESULT"}
        </span>
        <Agent agent={item.agent} />
        <span className="text-sm text-slate-100 truncate min-w-0 flex-1">{item.title}</span>
        <span className="text-[11px] text-slate-500">
          {revising ? <span className="text-amber-300 animate-pulse">writing v{item.plan.version + 1} with your markup…</span> : ago(item.finishedAt)}
        </span>
        {!revising && <span className="text-slate-500 text-xs">{open ? "▲" : "▼"}</span>}
      </button>
      {open && !revising && (
        <div className="px-3 pb-3 border-t border-slate-800 pt-3">
          {item.kind === "plan" ? (
            <PlanReview taskId={item.id} plan={item.plan} onDone={onDone} />
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-300 whitespace-pre-wrap">{item.preview}{item.preview.length >= 280 ? "…" : ""}</p>
              {error && <p className="text-xs text-rose-300">{error}</p>}
              <div className="flex gap-2">
                <button disabled={busy} onClick={() => void accept()} className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-50">
                  ✓ Accept
                </button>
                <button onClick={() => (location.hash = "#board")} className="px-3 py-1.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm">
                  Open the board
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function InboxPage() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    getJson<Inbox>("/api/inbox")
      .then((d) => {
        setInbox(d);
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, []);

  if (!inbox)
    return <div className="col-span-3 p-6 text-sm text-slate-500">{error ? `Couldn't load the inbox: ${error}` : "Loading the inbox…"}</div>;

  const nothing = !inbox.questions.length && !inbox.review.length && !inbox.approvals;
  return (
    <div className="col-span-3 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6 pb-8">
        {nothing && (
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-400">
            <p className="text-slate-200 font-medium">Nothing is waiting on you.</p>
            <p className="mt-1">
              Agents leave questions here instead of stopping to wait, and cards marked <b>Plan first</b> park their plan here for your markup.
            </p>
          </div>
        )}
        <Section title="Questions" count={inbox.questions.length + inbox.approvals} hint="answer when you're ready; nobody is blocked">
          {inbox.approvals > 0 && (
            <p className="text-xs text-amber-300 bg-amber-950/30 border border-amber-800/50 rounded-md px-3 py-2">
              ⏸ {inbox.approvals} action{inbox.approvals > 1 ? "s" : ""} waiting for your approval at the top of the page. These do pause their card.
            </p>
          )}
          {inbox.questions.map((q) => (
            <QuestionCard key={q.id} q={q} onDone={() => void load()} />
          ))}
          {!inbox.questions.length && !inbox.approvals && <p className="text-xs text-slate-600">No questions.</p>}
        </Section>
        <Section title="To review" count={inbox.review.length} hint="plans to mark up, results you wanted to check">
          {inbox.review.map((r) => (
            <ReviewRow key={`${r.id}:${r.kind === "plan" ? r.plan.version : 0}`} item={r} onDone={() => void load()} />
          ))}
          {!inbox.review.length && <p className="text-xs text-slate-600">Nothing to review.</p>}
        </Section>
        <Section title="Finished work" count={inbox.finished.length} hint="the last 3 days">
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-slate-900">
            {inbox.finished.map((c) => (
              <li key={c.id} className="p-3 flex gap-3 items-start">
                <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${c.status === "complete" ? "bg-emerald-400" : c.status === "error" ? "bg-rose-400" : "bg-slate-500"}`} title={c.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-100 truncate">{c.title}</span>
                    <Agent agent={c.agent} />
                    <span className="ml-auto text-[11px] text-slate-500 shrink-0">{ago(c.finishedAt)}</span>
                  </div>
                  {c.preview && <p className="text-xs text-slate-400 line-clamp-2 mt-0.5">{c.preview}</p>}
                </div>
              </li>
            ))}
            {!inbox.finished.length && <li className="p-3 text-xs text-slate-600">Nothing finished lately.</li>}
          </ul>
        </Section>
      </div>
    </div>
  );
}
