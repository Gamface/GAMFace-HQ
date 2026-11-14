import { useMemo, useState } from "react";

// Live preview of the HTML / CSS / JavaScript in an agent's answer. The page
// runs in a sandboxed iframe with no access to Mission Control (no
// allow-same-origin), so generated code can't touch the dashboard or its data.

interface CodeBlock {
  lang: string;
  code: string;
}

const WEB_LANGS: Record<string, "html" | "css" | "js"> = {
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  css: "css",
  js: "js",
  javascript: "js",
  jsx: "js",
};

export function extractBlocks(output: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const m of output.matchAll(/```([\w+-]*)[^\n]*\n([\s\S]*?)```/g)) {
    let lang = m[1].toLowerCase();
    const code = m[2];
    if (!lang && /^\s*(<!doctype|<html|<body|<div|<svg)/i.test(code)) lang = "html";
    blocks.push({ lang: lang || "text", code });
  }
  return blocks;
}

export function buildDocument(blocks: CodeBlock[]): string | null {
  const html = [...blocks].reverse().find((b) => WEB_LANGS[b.lang] === "html")?.code;
  const css = blocks.filter((b) => WEB_LANGS[b.lang] === "css").map((b) => b.code).join("\n");
  const js = blocks.filter((b) => WEB_LANGS[b.lang] === "js").map((b) => b.code).join("\n;\n");
  if (!html && !css && !js) return null;
  let doc = html ?? "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>";
  if (!/<html[\s>]/i.test(doc)) doc = `<!doctype html><html><head><meta charset="utf-8"></head><body>${doc}</body></html>`;
  if (css) doc = doc.includes("</head>") ? doc.replace("</head>", `<style>${css}</style></head>`) : `<style>${css}</style>${doc}`;
  if (js) {
    const script = `<script>${js.replace(/<\/script>/gi, "<\\/script>")}</script>`;
    doc = doc.includes("</body>") ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${script}</body>`) : doc + script;
  }
  return doc;
}

export default function PreviewPane({ output, active }: { output: string; active: boolean }) {
  const [reload, setReload] = useState(0);
  const [showCode, setShowCode] = useState(false);
  const blocks = useMemo(() => extractBlocks(output), [output]);
  // Rebuild only when the answer is finished, so a half-written page doesn't flicker
  const doc = useMemo(() => (active ? null : buildDocument(blocks)), [blocks, active]);
  const otherLangs = [...new Set(blocks.filter((b) => !WEB_LANGS[b.lang]).map((b) => b.lang))];

  const openInTab = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([doc], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-800 text-xs">
        <span className="text-slate-500 font-mono">{blocks.length} code block{blocks.length === 1 ? "" : "s"}</span>
        <div className="flex-1" />
        <button onClick={() => setShowCode((v) => !v)} className="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700">
          {showCode ? "Hide code" : "Show code"}
        </button>
        <button onClick={() => setReload((n) => n + 1)} disabled={!doc} className="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
          ↻ Reload
        </button>
        <button onClick={openInTab} disabled={!doc} className="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
          ↗ Open in tab
        </button>
        <button onClick={() => doc && navigator.clipboard.writeText(doc)} disabled={!doc} className="px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40">
          Copy HTML
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {active ? (
          <p className="p-6 text-slate-500 italic font-mono text-sm">// Waiting for the agent to finish writing…</p>
        ) : doc ? (
          <iframe
            key={reload}
            title="Code preview"
            srcDoc={doc}
            sandbox="allow-scripts allow-forms allow-modals allow-popups"
            className={`w-full bg-white ${showCode ? "h-1/2" : "flex-1"}`}
          />
        ) : (
          <div className="p-6 text-slate-500 text-sm font-mono space-y-2">
            <p>// Nothing to preview yet.</p>
            <p>// Preview renders HTML, CSS and JavaScript from the selected task. Try asking the coder for "a single-file HTML page that…".</p>
            {otherLangs.length > 0 && <p>// This answer has {otherLangs.join(", ")} code, which needs to run outside the browser.</p>}
          </div>
        )}
        {showCode && (
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 bg-slate-950">
            {blocks.map((b, i) => (
              <div key={i} className="border border-slate-800 rounded">
                <div className="flex justify-between px-3 py-1 text-[11px] text-slate-500 border-b border-slate-800">
                  <span>{b.lang}</span>
                  <button onClick={() => navigator.clipboard.writeText(b.code)} className="hover:text-slate-200">
                    Copy
                  </button>
                </div>
                <pre className="p-3 text-xs text-slate-300 overflow-x-auto">{b.code}</pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
