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

export function studioTools(opts: { studio: StudioFetch; chat: JsonChat }): LocalToolServer {
  const { studio, chat } = opts;
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
    description: "Mission Control's music studio: find tracks in the user's Music folder, add them, write lyrics, sing lyrics over an instrumental, make songs (ACE-Step on this PC's graphics card)",
    notes:
      "To put lyrics on a track the user names (a file path like C:\\Users\\...\\Song.mp3, or a title): studio.list_songs to see if it's already in the studio; if not, studio.find_music then studio.import_song with the path; then studio.add_vocals with that song " +
      "(it writes lyrics from the theme when you don't pass any). Songs and vocals take a few minutes on the graphics card: the tools start the job and the result appears on the Studio page; studio.job_status checks on it. " +
      "You can write lyrics yourself with studio.write_lyrics. Never say you can't write lyrics or reach the file: use these tools.",
    timeoutMs: 180_000,
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
    ],
  };
}
