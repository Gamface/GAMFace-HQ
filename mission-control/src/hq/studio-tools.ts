import type { ChatMessage, JsonChat } from "./ollama";
import type { LocalToolServer } from "./tools";

// The music studio as tools for Jarvis: find a track in the shared Music folder, add it to the
// library, write lyrics, sing them over an instrumental, make a new song, and check on jobs.
// They run in the harness (only it can reach the studio). Adding a track and starting a job
// change things, so each asks the user first like any other such tool.

export interface StudioSong {
  id: string;
  title: string;
  status?: string;
  duration?: number;
  bpm?: number;
  key?: string;
  source?: string;
  lyrics?: string;
  prompt?: string;
}

export type StudioFetch = (path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>;

interface PictureOut {
  file?: string;
  path?: string;
  name?: string;
  width?: number;
  height?: number;
  preview?: string;
  gridStep?: number | null;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|psd|svg|pdf)$/i;

/** Sections to write for a song this long: enough words to fill it, not so many they're rushed. */
export function lyricShape(seconds: number): string {
  if (seconds <= 75) return "[Verse] (4 lines), [Chorus] (4 lines)";
  if (seconds <= 150) return "[Verse] (6 lines), [Chorus] (4 lines), [Verse] (6 lines), [Chorus] (4 lines)";
  if (seconds <= 240) return "[Intro] (2 lines), [Verse] (8 lines), [Chorus] (4 lines), [Verse] (8 lines), [Chorus] (4 lines), [Bridge] (4 lines), [Chorus] (4 lines)";
  return "[Intro] (2 lines), [Verse] (8 lines), [Pre-Chorus] (2 lines), [Chorus] (4 lines), [Verse] (8 lines), [Pre-Chorus] (2 lines), [Chorus] (4 lines), [Bridge] (4 lines), [Chorus] (4 lines), [Outro] (2 lines)";
}

export const LYRICS_SYSTEM =
  "You are a songwriter. Write original song lyrics for the brief, ready to be sung by an AI singer (ACE-Step).\n" +
  "Rules:\n" +
  "- Put each section's tag on its own line in square brackets ([Verse], [Chorus], [Bridge], ...), then its lines.\n" +
  "- Lines short enough to sing on the beat at the given tempo; a chorus that repeats a hook.\n" +
  "- Original words only: never copy or closely imitate the lyrics of an existing song.\n" +
  "- Match the style and theme; nothing hateful, sexual or about real private people.\n" +
  'Reply with JSON only: {"lyrics": "<the lyrics, with \\n between lines>"}';

/** Lyrics in ACE-Step's format: section tags on their own lines, nothing else around them. */
export function cleanLyrics(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/^```[a-z]*\n?|```$/gim, "")
    .split("\n")
    .map((l) => l.trim().replace(/^\*\*?(\[[^\]]+\])\*\*?$/, "$1").replace(/^\(([A-Za-z -]+)\)$/, "[$1]"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

export async function writeLyrics(
  chat: JsonChat,
  brief: { theme: string; style?: string; title?: string; seconds?: number; bpm?: number; key?: string; language?: string },
): Promise<string> {
  const seconds = brief.seconds && brief.seconds > 0 ? brief.seconds : 120;
  const messages: ChatMessage[] = [
    { role: "system", content: LYRICS_SYSTEM },
    {
      role: "user",
      content:
        [
          `Theme: ${brief.theme || "whatever fits the title and style"}`,
          brief.title ? `Song title: ${brief.title}` : "",
          brief.style ? `Style: ${brief.style}` : "",
          `Length: ${Math.round(seconds)} seconds${brief.bpm ? ` at ${brief.bpm} BPM` : ""}${brief.key ? ` in ${brief.key}` : ""}`,
          `Language: ${brief.language && brief.language !== "en" ? brief.language : "English"}`,
          `Sections: ${lyricShape(seconds)}`,
        ]
          .filter(Boolean)
          .join("\n") + "\n\nWrite the lyrics now.",
    },
  ];
  const out = (await chat("planner", messages)) as { lyrics?: unknown };
  const lyrics = cleanLyrics(typeof out.lyrics === "string" ? out.lyrics : "");
  if (lyrics.split("\n").filter((l) => l && !l.startsWith("[")).length < 2) throw new Error("The lyric writer didn't return any lyrics; try again");
  return lyrics;
}

const norm = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ").trim();

/** A library song from an id or (part of) its title. Throws with the choices when it's unclear. */
export function pickSong(songs: StudioSong[], ref: string): StudioSong {
  const want = String(ref ?? "").trim();
  if (!want) throw new Error("Say which song (its title or id). Songs in the studio: " + listTitles(songs));
  const byId = songs.find((s) => s.id === want);
  if (byId) return byId;
  const w = norm(want);
  const exact = songs.filter((s) => norm(s.title) === w);
  if (exact.length) return exact.sort((a, b) => b.id.localeCompare(a.id))[0];
  const words = w.split(" ").filter((x) => x.length > 1);
  const hits = songs.filter((s) => {
    const t = norm(s.title);
    return t.includes(w) || (words.length > 0 && words.every((x) => t.includes(x)));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`More than one song matches "${want}": ${listTitles(hits)}. Say which one (title or id).`);
  throw new Error(`No song called "${want}" in the studio. Songs there: ${listTitles(songs)}. To add a file from the Music folder, use studio.find_music, then studio.import_song.`);
}

const listTitles = (songs: StudioSong[]) => (songs.length ? songs.slice(0, 15).map((s) => `"${s.title}" (${s.id})`).join(", ") : "none yet");

const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

function describe(s: StudioSong): string {
  const bits = [
    s.status ? `status ${s.status === "ready" ? "ready (split into stems)" : s.status}` : "",
    s.duration ? `${Math.round(s.duration)} s` : "",
    s.bpm ? `${s.bpm} BPM` : "",
    s.key ?? "",
    s.lyrics ? "has lyrics" : "no lyrics",
    s.source ? `from ${s.source}` : "",
  ].filter(Boolean);
  return `- "${s.title}" (id ${s.id}): ${bits.join(", ")}`;
}

export function studioTools(opts: {
  studio: StudioFetch;
  chat: JsonChat;
  /** A picture saved on a card (by name), so Jarvis can work on pictures the picture tool made */
  cardFile?: (name: string) => Buffer | null;
  /** How long a picture job (upscale, repaint) is waited for before Jarvis answers */
  jobWaitMs?: number;
}): LocalToolServer {
  const { studio, chat } = opts;
  const jobWait = opts.jobWaitMs ?? 8 * 60_000;
  /** The studio path of a picture named by its studio path, a card file, a PC path or part of its name. */
  const pictureRef = async (ref: unknown): Promise<string> => {
    const want = str(ref, 1000);
    if (!want) throw new Error("Say which picture (list them with studio.list_pictures)");
    if (/^(pictures|outputs)\//.test(want)) return want;
    const card = opts.cardFile && IMAGE_EXT.test(want) && !/[\\/]/.test(want) ? opts.cardFile(want) : null;
    if (card) {
      const added = (await studio("/pictures", { method: "POST", body: { filename: want, data: card.toString("base64") } })) as PictureOut;
      return added.path!;
    }
    if (/[\\/]/.test(want) && IMAGE_EXT.test(want)) {
      const added = (await studio("/pictures/import", { method: "POST", body: { path: want } })) as PictureOut;
      return added.path!;
    }
    const all = ((await studio("/pictures")) as { pictures?: PictureOut[] }).pictures ?? [];
    const w = norm(want);
    const hits = all.filter((p) => norm(p.name ?? "").includes(w) || norm(p.path ?? "").includes(w));
    if (hits.length >= 1) return hits[0].path!; // newest first
    throw new Error(`No picture "${want}" in the studio. Add it with studio.add_picture (a path on the PC or a picture on this card), or list them with studio.list_pictures.`);
  };
  const shown = (out: PictureOut, what: string) => ({
    text: `${what}: ${out.file ?? out.path} (${out.width}x${out.height}). It's shown on the card and saved in the Studio's pictures.`,
    ...(out.preview ? { media: [{ mimeType: "image/jpeg" as const, data: out.preview }] } : {}),
  });
  const waitJob = async (id: string) => {
    type Job = { id: string; title: string; status: string; progress?: string; error?: string; result?: { message?: string; picture?: string } };
    const until = Date.now() + jobWait;
    for (;;) {
      const j = (await studio(`/jobs/${id}`)) as Job;
      if (j.status === "done") {
        const pic = j.result?.picture;
        const thumb = pic ? ((await studio(`/pictures/thumb?path=${encodeURIComponent(pic)}`)) as PictureOut) : null;
        return thumb ? shown({ ...thumb, file: pic }, j.result?.message ?? "Done") : { text: j.result?.message ?? "Done" };
      }
      if (j.status === "failed" || j.status === "cancelled") return { text: `${j.title} ${j.status}: ${j.error ?? ""}`, isError: true };
      if (Date.now() > until) return { text: `${j.title} is still ${j.status}${j.progress ? ` (${j.progress})` : ""}: job ${j.id}. It lands on the Studio page when done; check with studio.job_status.` };
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  const box = { type: "array", items: { type: "number" }, description: "[x0, y0, x1, y1] in pixels" };
  const songs = async () => ((await studio("/songs")) as { songs?: StudioSong[] }).songs ?? [];
  const startJob = async (body: Record<string, unknown>) => (await studio("/jobs", { method: "POST", body })) as { id: string; title: string };
  const lyricsFor = async (song: StudioSong | null, a: Record<string, unknown>) =>
    writeLyrics(chat, {
      theme: str(a.theme, 600) || (song ? `a song called "${song.title.replace(/[-_]+/g, " ")}"` : ""),
      style: str(a.style, 300) || song?.prompt,
      title: song?.title.replace(/[-_]+/g, " "),
      seconds: song?.duration ?? num(a.seconds),
      bpm: song?.bpm ?? num(a.bpm),
      key: song?.key ?? str(a.key, 20),
      language: str(a.language, 8) || "en",
    });

  return {
    name: "studio",
    description:
      "Mission Control's studio: find tracks in the user's Music folder, add them, write lyrics, sing lyrics over an instrumental, make songs (ACE-Step); and work on pictures: text on artwork, SVG designs, upscale 4x, repaint parts, composite, convert",
    notes:
      "To put lyrics on a track the user names (a file path like C:\\Users\\...\\Song.mp3, or a title): studio.list_songs to see if it's already in the studio; if not, studio.find_music then studio.import_song with the path; then studio.add_vocals with that song " +
      "(it writes lyrics from the theme when you don't pass any). Songs and vocals take a few minutes on the graphics card: the tools start the job and the result appears on the Studio page; studio.job_status checks on it. " +
      "You can write lyrics yourself with studio.write_lyrics. Never say you can't write lyrics or reach the file: use these tools. " +
      "PICTURES: name a picture by its studio path (pictures/... or outputs/...), a picture's file name on this card, or a path on the PC. Picture tools never change the original: each makes a new file. " +
      "To fix part of a picture: studio.preview_picture (it shows a pixel grid on the card and gives the size), then studio.edit_picture with boxes in those pixels. " +
      "For print covers under 300 dpi, studio.upscale_picture. For a title on artwork use studio.picture_text (real, sharp text) rather than asking the picture model to draw letters.",
    timeoutMs: 10 * 60_000,
    tools: [
      {
        name: "list_songs",
        description: "The songs in the studio library: title, id, length, tempo, key, whether they have lyrics and stems",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        run: async () => {
          const all = await songs();
          return { text: all.length ? all.map(describe).join("\n") : "The studio library is empty." };
        },
      },
      {
        name: "find_music",
        description: "Searches the user's shared Music folder on the PC for audio files (by words in the file name)",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "words from the file name; empty lists everything" } } },
        readOnly: true,
        run: async (a) => {
          // A whole path works too: search by its file name
          const q = str(a.query, 300).replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]{2,4}$/i, "");
          const out = (await studio(`/import?q=${encodeURIComponent(q)}`)) as { files?: { path: string; sizeMB: number }[]; error?: string };
          if (out.error) return { text: out.error, isError: true };
          const files = out.files ?? [];
          return { text: files.length ? files.slice(0, 40).map((f) => `- ${f.path} (${f.sizeMB} MB)`).join("\n") : `No audio files matching "${q}" in the Music folder.` };
        },
      },
      {
        name: "import_song",
        description: "Adds an audio file from the user's Music folder to the studio library (and splits it into stems)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "the file's path as the user wrote it (C:\\Users\\...\\Song.mp3) or as studio.find_music listed it" },
            title: { type: "string", description: "a title; defaults to the file name" },
            split: { type: "boolean", description: "split into stems afterwards (default true)" },
          },
          required: ["path"],
        },
        readOnly: false,
        annotations: { destructiveHint: false },
        run: async (a) => {
          const meta = (await studio("/songs/import", { method: "POST", body: { path: str(a.path, 1000), title: str(a.title, 120), split: a.split !== false } })) as StudioSong & { importedFrom?: string };
          return { text: `Added "${meta.title}" (id ${meta.id}, ${Math.round(meta.duration ?? 0)} s) to the studio from ${meta.importedFrom}.${a.split !== false ? " It's being split into stems." : ""}` };
        },
      },
      {
        name: "write_lyrics",
        description: "Writes original lyrics (with [Verse]/[Chorus] tags) for a theme, sized to a studio song's length and tempo",
        inputSchema: {
          type: "object",
          properties: {
            theme: { type: "string", description: "what the song is about" },
            song: { type: "string", description: "a studio song's title or id, to fit its length and tempo (optional)" },
            style: { type: "string", description: "genre and delivery, e.g. 'trap, male rapper, hype'" },
            language: { type: "string", description: "language code, default en" },
          },
          required: ["theme"],
        },
        readOnly: true,
        run: async (a) => {
          const song = str(a.song) ? pickSong(await songs(), str(a.song)) : null;
          return { text: await lyricsFor(song, a) };
        },
      },
      {
        name: "add_vocals",
        description: "Sings lyrics over an instrumental in the studio and saves the finished song (ACE-Step on the graphics card, a few minutes). Writes the lyrics from the theme when none are given.",
        inputSchema: {
          type: "object",
          properties: {
            song: { type: "string", description: "the instrumental's title or id in the studio" },
            lyrics: { type: "string", description: "lyrics with [Verse]/[Chorus] tags; leave out to have them written" },
            theme: { type: "string", description: "what the lyrics should be about (when writing them)" },
            style: { type: "string", description: "voice and delivery, e.g. 'female soul singer' or 'male rapper, aggressive'" },
            strength: { type: "number", description: "0.3-0.8: how freely ACE-Step reworks the track around the vocals (default 0.55)" },
            language: { type: "string", description: "language code, default en" },
          },
          required: ["song"],
        },
        readOnly: false,
        annotations: { destructiveHint: false },
        run: async (a) => {
          const song = pickSong(await songs(), str(a.song));
          const lyrics = str(a.lyrics) ? str(a.lyrics) : await lyricsFor(song, a);
          const job = await startJob({
            type: "vocals",
            song: song.id,
            lyrics,
            prompt: str(a.style, 300),
            ...(num(a.strength) !== undefined ? { strength: num(a.strength) } : {}),
            language: str(a.language, 8) || "en",
          });
          return { text: `Started "${job.title}" (job ${job.id}). It takes a few minutes; the finished song appears on the Studio page and in the library as "${song.title} (vocals)".\n\nLyrics used:\n${lyrics}` };
        },
      },
      {
        name: "make_song",
        description: "Makes a new song from a description (ACE-Step on the graphics card, a few minutes), with lyrics or instrumental",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "style, instruments, mood, voice" },
            title: { type: "string" },
            lyrics: { type: "string", description: "lyrics with [Verse]/[Chorus] tags; '[Instrumental]' for none" },
            theme: { type: "string", description: "what to write lyrics about, when no lyrics are given" },
            seconds: { type: "number", description: "length, 10-600 (default 120)" },
            bpm: { type: "number" },
            key: { type: "string", description: "e.g. 'A minor'" },
            language: { type: "string" },
          },
          required: ["prompt"],
        },
        readOnly: false,
        annotations: { destructiveHint: false },
        run: async (a) => {
          const seconds = Math.max(10, Math.min(600, num(a.seconds) ?? 120));
          const lyrics = str(a.lyrics) || (str(a.theme) ? await writeLyrics(chat, { theme: str(a.theme, 600), style: str(a.prompt, 300), title: str(a.title, 120), seconds, bpm: num(a.bpm), key: str(a.key, 20), language: str(a.language, 8) }) : "");
          const job = await startJob({
            type: "song",
            prompt: str(a.prompt, 500),
            title: str(a.title, 120),
            lyrics,
            seconds,
            ...(num(a.bpm) ? { bpm: Math.round(num(a.bpm)!) } : {}),
            ...(str(a.key, 20) ? { key: str(a.key, 20) } : {}),
            language: str(a.language, 8) || "en",
          });
          return { text: `Started "${job.title}" (job ${job.id}); it appears on the Studio page in a few minutes.${lyrics ? `\n\nLyrics:\n${lyrics}` : " (instrumental)"}` };
        },
      },
      {
        name: "job_status",
        description: "How studio jobs are going (the latest ones, or one by id)",
        inputSchema: { type: "object", properties: { job: { type: "string", description: "a job id (optional)" } } },
        readOnly: true,
        run: async (a) => {
          type Job = { id: string; title: string; status: string; progress?: string; error?: string; result?: { message?: string } };
          const id = str(a.job, 20);
          const list: Job[] = /^[a-f0-9]{12}$/.test(id) ? [(await studio(`/jobs/${id}`)) as Job] : (((await studio("/jobs")) as { jobs?: Job[] }).jobs ?? []).slice(0, 6);
          if (!list.length) return { text: "No studio jobs yet." };
          return { text: list.map((j) => `- ${j.title} (job ${j.id}): ${j.status}${j.progress ? `, ${j.progress}` : ""}${j.error ? ` — ${j.error}` : ""}${j.result?.message ? ` — ${j.result.message}` : ""}`).join("\n") };
        },
      },
      {
        name: "list_pictures",
        description: "The pictures in the studio (added ones and what the picture tools made), newest first",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "words from the name (optional)" } } },
        readOnly: true,
        run: async (a) => {
          const all = ((await studio("/pictures")) as { pictures?: PictureOut[] }).pictures ?? [];
          const w = norm(str(a.query, 200));
          const hits = w ? all.filter((p) => norm(p.path ?? "").includes(w)) : all;
          return { text: hits.length ? hits.slice(0, 40).map((p) => `- ${p.path} (${p.width}x${p.height})`).join("\n") : "No pictures in the studio yet." };
        },
      },
      {
        name: "find_pictures",
        description: "Searches the user's shared Pictures, Downloads and Music folders on the PC for pictures (by words in the file name)",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        readOnly: true,
        run: async (a) => {
          const q = str(a.query, 300).replace(/^.*[\\/]/, "").replace(IMAGE_EXT, "");
          const out = (await studio(`/shared?kind=pictures&q=${encodeURIComponent(q)}`)) as { files?: { folder: string; path: string; sizeMB: number }[]; error?: string };
          if (out.error) return { text: out.error, isError: true };
          const files = out.files ?? [];
          return { text: files.length ? files.slice(0, 40).map((f) => `- ${f.folder}: ${f.path} (${f.sizeMB} MB)`).join("\n") : `No pictures matching "${q}" in the shared folders.` };
        },
      },
      {
        name: "add_picture",
        description: "Adds a picture to the studio: from a path on the PC (shared Pictures/Downloads folder) or a picture saved on this card",
        inputSchema: { type: "object", properties: { picture: { type: "string", description: "C:\\Users\\...\\x.png, a find_pictures path, or a card file name" } }, required: ["picture"] },
        readOnly: true,
        run: async (a) => {
          const path = await pictureRef(a.picture);
          const thumb = (await studio(`/pictures/thumb?path=${encodeURIComponent(path)}`)) as PictureOut;
          return shown({ ...thumb, file: path }, "Added");
        },
      },
      {
        name: "picture_text",
        description: "Puts real, sharp text on a picture (Inkscape): a title and an optional subtitle or credit, e.g. a cover title or a thumbnail caption",
        inputSchema: {
          type: "object",
          properties: {
            picture: { type: "string" },
            title: { type: "string", description: "the main text (\\n for a second line)" },
            subtitle: { type: "string" },
            position: { type: "string", enum: ["top", "center", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"] },
            color: { type: "string", description: "#rrggbb, default white" },
            size: { type: "number", description: "title size in pixels (default: fits the picture)" },
          },
          required: ["picture", "title"],
        },
        readOnly: true,
        run: async (a) => {
          const picture = await pictureRef(a.picture);
          const out = (await studio("/pictures/text", { method: "POST", body: { picture, title: str(a.title, 200), subtitle: str(a.subtitle, 200), position: str(a.position, 20) || "bottom", color: str(a.color, 7) || "#ffffff", size: num(a.size) ?? 0 } })) as PictureOut;
          return shown(out, "Made");
        },
      },
      {
        name: "svg_design",
        description: "Renders a design you write as SVG (title cards, posters, cover layouts, logos, lower thirds) to PNG or PDF. Self-contained SVG only: no links to files or the web",
        inputSchema: {
          type: "object",
          properties: {
            svg: { type: "string", description: "a complete <svg> with width, height and viewBox" },
            title: { type: "string" },
            format: { type: "string", enum: ["png", "pdf"] },
            width: { type: "number", description: "PNG width in pixels (optional)" },
          },
          required: ["svg"],
        },
        readOnly: true,
        run: async (a) => {
          const out = (await studio("/pictures/svg", { method: "POST", body: { svg: str(a.svg, 2_000_000), title: str(a.title, 80) || "design", format: str(a.format, 4) || "png", width: num(a.width) ?? 0 } })) as PictureOut;
          return out.preview ? shown(out, "Rendered") : { text: `Rendered ${out.file} (PDF), with its SVG next to it.` };
        },
      },
      {
        name: "preview_picture",
        description: "Shows a picture on the card with a labelled pixel grid (and edit boxes in red, keep boxes in green) to plan an edit, or a numbered contact sheet of several pictures",
        inputSchema: {
          type: "object",
          properties: {
            pictures: { type: "array", items: { type: "string" }, description: "one picture (grid) or several (contact sheet)" },
            boxes: { type: "array", items: box, description: "boxes to repaint, drawn in red" },
            keep: { type: "array", items: box, description: "boxes to keep, drawn in green" },
            grid: { type: "boolean" },
          },
          required: ["pictures"],
        },
        readOnly: true,
        run: async (a) => {
          const names = Array.isArray(a.pictures) ? a.pictures.slice(0, 12) : [a.pictures];
          const refs = [];
          for (const n of names) refs.push(await pictureRef(n));
          const out = (await studio("/pictures/preview", { method: "POST", body: { pictures: refs, boxes: a.boxes ?? [], keep: a.keep ?? [], grid: a.grid !== false } })) as PictureOut & { size?: number[] };
          return {
            ...shown(out, refs.length > 1 ? "Contact sheet" : "Preview"),
            text: refs.length > 1 ? `Contact sheet of ${refs.length} pictures, numbered in order: ${refs.join(", ")}` : `${refs[0]} is ${out.size?.[0]}x${out.size?.[1]} pixels${out.gridStep ? `; grid lines every ${out.gridStep} px` : ""}. The preview is on the card.`,
          };
        },
      },
      {
        name: "composite_pictures",
        description: "Pastes part of one picture into another: source_box from the source, placed with its top-left at `at` on the base; optional scale, colour match, feathered edges and keying out a plain background",
        inputSchema: {
          type: "object",
          properties: {
            base: { type: "string" },
            source: { type: "string" },
            source_box: box,
            at: { type: "array", items: { type: "number" }, description: "[x, y] on the base" },
            scale: { type: "number" },
            feather: { type: "number", description: "soft edge in pixels (default 12)" },
            match: { type: "boolean", description: "match the colours to the base (default true)" },
            key: { type: "string", description: "make a plain background see-through: white, black or #rrggbb" },
          },
          required: ["base", "source", "source_box", "at"],
        },
        readOnly: true,
        run: async (a) => {
          const body = { base: await pictureRef(a.base), source: await pictureRef(a.source), source_box: a.source_box, at: a.at, scale: num(a.scale) ?? 1, feather: num(a.feather) ?? 12, match: a.match !== false, key: str(a.key, 8) };
          return shown((await studio("/pictures/composite", { method: "POST", body })) as PictureOut, "Made");
        },
      },
      {
        name: "convert_picture",
        description: "Converts a picture to png, jpg, webp, tiff or pdf",
        inputSchema: { type: "object", properties: { picture: { type: "string" }, to: { type: "string", enum: ["png", "jpg", "webp", "tiff", "pdf"] } }, required: ["picture", "to"] },
        readOnly: true,
        run: async (a) => {
          const out = (await studio("/pictures/convert", { method: "POST", body: { picture: await pictureRef(a.picture), to: str(a.to, 5) } })) as PictureOut;
          return out.preview ? shown(out, "Converted") : { text: `Converted: ${out.file}` };
        },
      },
      {
        name: "upscale_picture",
        description: "Makes a picture 4x larger and sharper (Real-ESRGAN on the graphics card), e.g. so a cover reaches 300 dpi for print",
        inputSchema: { type: "object", properties: { picture: { type: "string" } }, required: ["picture"] },
        readOnly: true,
        run: async (a) => {
          const job = await startJob({ type: "upscale", picture: await pictureRef(a.picture) });
          return waitJob(job.id);
        },
      },
      {
        name: "edit_picture",
        description: "Repaints parts of a picture from a description (remove something, replace it, even out a background) on the graphics card. Only the boxes change; keep boxes inside them stay as they are",
        inputSchema: {
          type: "object",
          properties: {
            picture: { type: "string" },
            prompt: { type: "string", description: "what the boxes should show instead, as a visual description" },
            boxes: { type: "array", items: box },
            keep: { type: "array", items: box },
            strength: { type: "number", description: "0.5-1.0, how freely to repaint (default 0.9)" },
          },
          required: ["picture", "prompt", "boxes"],
        },
        readOnly: true,
        run: async (a) => {
          const job = await startJob({ type: "edit", picture: await pictureRef(a.picture), prompt: str(a.prompt, 1500), boxes: a.boxes, keep: a.keep ?? [], ...(num(a.strength) !== undefined ? { strength: num(a.strength) } : {}) });
          return waitJob(job.id);
        },
      },
    ],
  };
}
