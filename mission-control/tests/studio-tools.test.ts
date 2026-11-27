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
  assert.ok(!ro.includes("import_song") && !ro.includes("add_vocals") && !ro.includes("make_song"), "routines only get the read-only ones");
  assert.ok(ro.includes("write_lyrics") && ro.includes("picture_text") && ro.includes("upscale_picture"));

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

test("picture tools: a card picture goes to the studio, edits wait for the job and show the result", async () => {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  let polls = 0;
  const studio = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    calls.push({ path, ...init });
    if (path === "/pictures" && init.method === "POST") return { path: "pictures/images-sunset.png", width: 1216, height: 832 };
    if (path === "/pictures") return { pictures: [{ path: "outputs/pictures/cover-1a2b3c/cover-4x.png", name: "cover-4x.png", width: 4864, height: 3328 }] };
    if (path === "/pictures/text") return { file: "outputs/pictures/x-text/x-text.png", width: 1216, height: 832, preview: "QUJD" };
    if (path === "/jobs" && init.method === "POST") return { id: "ffffffffffff", title: "Repaint" };
    if (path === "/jobs/ffffffffffff") return ++polls < 2 ? { id: "ffffffffffff", title: "Repaint", status: "running", progress: "repainting" } : { id: "ffffffffffff", title: "Repaint", status: "done", result: { message: "Repainted 1 part", picture: "outputs/pictures/e/e.png" } };
    if (path.startsWith("/pictures/thumb")) return { path: "outputs/pictures/e/e.png", width: 1216, height: 832, preview: "REVG" };
    throw new Error("unexpected " + path);
  };
  const client = new ToolsClient("", [studioTools({ studio, chat: (async () => ({})) as never, cardFile: (n) => (n === "images-sunset.png" ? Buffer.from("png") : null), jobWaitMs: 10_000 })]);
  const text = await client.call("studio", "picture_text", { picture: "images-sunset.png", title: "ALL BLACKS" });
  assert.equal(text.isError, false, text.text);
  assert.equal(text.media?.[0].mimeType, "image/jpeg");
  assert.deepEqual((calls.find((c) => c.path === "/pictures/text")!.body as { picture: string }).picture, "pictures/images-sunset.png", "the card picture was added first");
  const named = await client.call("studio", "upscale_picture", { picture: "cover 4x" });
  assert.equal(named.isError, false);
  assert.equal((calls.filter((c) => c.path === "/jobs").at(-1)!.body as { picture: string }).picture, "outputs/pictures/cover-1a2b3c/cover-4x.png", "found by name");
  polls = 0;
  const edit = await client.call("studio", "edit_picture", { picture: "outputs/pictures/x.png", prompt: "clear sky", boxes: [[0, 0, 10, 10]] });
  assert.match(edit.text, /Repainted 1 part: outputs\/pictures\/e\/e\.png \(1216x832\)/);
  assert.equal(edit.media?.[0].data, "REVG");
});
