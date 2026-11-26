import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanLyrics, lyricShape, pickSong, studioTools, writeLyrics, type StudioSong } from "../src/hq/studio-tools";
import { ToolsClient, toolsFor } from "../src/hq/tools";
import { setToolsSummary, toolsAvailable } from "../src/hq/team";

const SONGS: StudioSong[] = [
  { id: "aaaaaaaaaaaa", title: "GAMFACE-ALL BLACKS-INSTRU", status: "ready", duration: 150, bpm: 140, key: "F minor" },
  { id: "bbbbbbbbbbbb", title: "Night Drive", status: "new", duration: 60 },
  { id: "cccccccccccc", title: "Night Ride", status: "new", duration: 60 },
];

test("songs are picked by id, title or the words of a file name", () => {
  assert.equal(pickSong(SONGS, "aaaaaaaaaaaa").id, "aaaaaaaaaaaa");
  assert.equal(pickSong(SONGS, "all blacks").id, "aaaaaaaaaaaa");
  assert.equal(pickSong(SONGS, "C:\\Users\\aldra\\Music\\GAMFACE-ALL BLACKS-INSTRU.mp3".replace(/^.*\\/, "")).id, "aaaaaaaaaaaa");
  assert.equal(pickSong(SONGS, "gamface all blacks instru.mp3").id, "aaaaaaaaaaaa");
  assert.throws(() => pickSong(SONGS, "night"), /More than one song.*Night Drive.*Night Ride/);
  assert.throws(() => pickSong(SONGS, "us blacks track"), /No song called/);
});

test("lyrics come back in ACE-Step's format", () => {
  assert.equal(cleanLyrics("```\n**[Verse]**\n line one \n(Chorus)\nhook\n\n\n\nend\n```"), "[Verse]\nline one\n[Chorus]\nhook\n\nend");
  assert.match(lyricShape(60), /^\[Verse\].*\[Chorus\]/);
  assert.match(lyricShape(200), /\[Bridge\]/);
});

test("the lyric writer is briefed with the song's length, tempo and key", async () => {
  let seen = "";
  const chat = async (_m: string, messages: { content: string }[]) => {
    seen = messages[1].content;
    return { lyrics: "[Verse]\nblack on black\nwe ride\n[Chorus]\nall blacks" };
  };
  const out = await writeLyrics(chat as never, { theme: "loyalty", seconds: 150, bpm: 140, key: "F minor" });
  assert.match(out, /^\[Verse\]/);
  assert.match(seen, /150 seconds at 140 BPM in F minor/);
  await assert.rejects(writeLyrics((async () => ({ lyrics: "" })) as never, { theme: "x" }), /didn't return any lyrics/);
});

test("Jarvis's studio tools: add vocals writes lyrics and starts the job; nothing changes without approval", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const studio = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, ...init });
    if (path === "/songs") return { songs: SONGS };
    if (path === "/jobs" && init.method === "POST") return { id: "dddddddddddd", title: "Add vocals: GAMFACE-ALL BLACKS-INSTRU" };
    if (path.startsWith("/import")) return { files: [{ path: "GAMFACE-ALL BLACKS-INSTRU.mp3", sizeMB: 3.4 }] };
    if (path === "/songs/import") return { id: "eeeeeeeeeeee", title: "GAMFACE-ALL BLACKS-INSTRU", duration: 150, importedFrom: "GAMFACE-ALL BLACKS-INSTRU.mp3" };
    throw new Error("unexpected " + path);
  };
  const chat = async () => ({ lyrics: "[Verse]\nblack on black\nwe ride\n[Chorus]\nall blacks" });
  const client = new ToolsClient("", [studioTools({ studio, chat: chat as never })]);
  const servers = await client.list();
  assert.deepEqual(servers.map((s) => s.name), ["studio"]);
  const ro = toolsFor({ routine: true }, servers).map((t) => t.name);
  assert.deepEqual(ro.sort(), ["find_music", "job_status", "list_songs", "write_lyrics"], "routines only get the read-only ones");

  await assert.rejects(client.call("studio", "add_vocals", { song: "all blacks" }), /needs your approval/);
  const found = await client.call("studio", "find_music", { query: "C:\\Users\\aldra\\Music\\GAMFACE-ALL BLACKS-INSTRU.mp3" });
  assert.match(found.text, /GAMFACE-ALL BLACKS-INSTRU\.mp3 \(3\.4 MB\)/);
  assert.equal(calls.at(-1)!.path, "/import?q=GAMFACE-ALL%20BLACKS-INSTRU", "searched by the file name");

  const imported = await client.call("studio", "import_song", { path: "C:\\Users\\aldra\\Music\\GAMFACE-ALL BLACKS-INSTRU.mp3" }, { approved: true });
  assert.match(imported.text, /Added "GAMFACE-ALL BLACKS-INSTRU" \(id eeeeeeeeeeee/);

  const out = await client.call("studio", "add_vocals", { song: "all blacks", style: "male rapper" }, { approved: true });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /Started .*job dddddddddddd.*Lyrics used:\n\[Verse\]/s);
  const job = calls.find((c) => c.path === "/jobs")!.body as Record<string, unknown>;
  assert.deepEqual({ type: job.type, song: job.song, prompt: job.prompt }, { type: "vocals", song: "aaaaaaaaaaaa", prompt: "male rapper" });

  const bad = await client.call("studio", "add_vocals", { song: "night" }, { approved: true });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /More than one song/);
});

test("the studio tools make the Tools teammate available on their own", () => {
  setToolsSummary("studio: add_vocals (asks first: Sings lyrics…)", ["studio.add_vocals"]);
  assert.equal(toolsAvailable(), true);
  setToolsSummary(null);
});
