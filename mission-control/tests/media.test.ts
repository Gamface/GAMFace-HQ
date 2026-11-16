import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { VoiceClient, extractNarration, sceneVoice, wantsCaptions, wantsOwnAudio, wantsVoice, wordsFor } from "../src/hq/voice";
import { Assets, BrandSchema, assetBlock, publicName, sniffAsset } from "../src/hq/assets";
import { extractScene, videoInstructions, wantsVertical } from "../src/hq/video";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");
const b64 = (b: Buffer) => b.toString("base64");
const wav = (seconds: number) => {
  const data = Buffer.alloc(Math.round(seconds * 16000) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};
const mp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(16)]);

test("voiceover, captions, recording and vertical requests are recognised", () => {
  for (const t of ["Make a promo video with a voiceover", "make a narrated explainer", "an intro video with a voice-over", "video read aloud by a narrator"]) assert.equal(wantsVoice(t), true, t);
  for (const t of ["Make a promo video for Gamface", "an animated logo", "a video about my voice training app"]) assert.equal(wantsVoice(t), false, t);
  assert.equal(wantsCaptions("add captions to it"), true);
  assert.equal(wantsCaptions("with subtitles please"), true);
  assert.equal(wantsCaptions("a caption-free logo sting"), true); // asks about captions either way; harmless
  assert.equal(wantsCaptions("make a promo"), false);
  assert.equal(wantsOwnAudio("Make a captioned video using my recording"), true);
  assert.equal(wantsOwnAudio("use the attached audio as the voiceover"), true);
  assert.equal(wantsOwnAudio("make a video about podcasts"), false);
  assert.equal(wantsVertical("a vertical reel for Instagram"), true);
  assert.equal(wantsVertical("a short video for YouTube"), false);
});

test("narration comes from the last narration block, without stage directions", () => {
  const answer = "```tsx\nimport { Promo } from \"./mc\";\nexport const Video = () => <Promo title=\"x\" />;\n```\n\n```narration\n[upbeat]\nNarrator: Gamface is back.\n(pause) Play free today.\n```\nIt shows the promo.";
  assert.equal(extractNarration(answer), "Gamface is back.\nPlay free today.");
  assert.equal(extractNarration("no blocks here"), null);
  assert.equal(extractNarration("```narration\n\n```"), null);
  assert.deepEqual(sceneVoice("// video: width=1920 voice=am_adam speed=1.2\n", "af_heart"), { voice: "am_adam", speed: 1.2 });
  assert.deepEqual(sceneVoice("// video: width=1920\n", "bf_emma"), { voice: "bf_emma", speed: 1 });
  assert.equal(sceneVoice("// video: speed=9", "af_heart").speed, 1.6);
  assert.equal(wordsFor(10), 24);
});

test("scenes that only use the kit are found", () => {
  const s = extractScene('```tsx\n// video: width=1080 height=1920 fps=30 seconds=12\nimport { Social } from "./mc";\nexport const Video = () => <Social hook="Hi" />;\n```');
  assert.ok(s);
  assert.equal(s!.height, 1920);
  assert.equal(s!.durationInFrames, 360);
});

test("instructions describe the kit, voiceover, captions, recording and assets", () => {
  const plain = videoInstructions(0);
  assert.match(plain, /from "\.\/mc"/);
  assert.match(plain, /Promo/);
  assert.doesNotMatch(plain, /narration/);
  const voiced = videoInstructions({ voice: true, captions: true, vertical: true });
  assert.match(voiced, /```narration block/);
  assert.match(voiced, /width=1080 height=1920/);
  assert.match(voiced, /voice=af_heart/);
  assert.match(voiced, /captions are added automatically/);
  const rec = videoInstructions({ recording: { seconds: 21.4, text: "" }, voice: true, captions: true });
  assert.match(rec, /recording \(21 s\)/);
  assert.match(rec, /transcript above/);
  assert.doesNotMatch(rec, /```narration block/);
  const silentCaptions = videoInstructions({ captions: true });
  assert.match(silentCaptions, /no voiceover, so show the text/);
  assert.match(videoInstructions({ assets: "- ASSETS: x" }), /- ASSETS: x/);
});

test("asset files are recognised by their bytes", () => {
  assert.equal(sniffAsset(PNG)?.kind, "image");
  assert.deepEqual(sniffAsset(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), { kind: "image", ext: "svg", mime: "image/svg+xml" });
  assert.equal(sniffAsset(wav(0.1))?.ext, "wav");
  assert.equal(sniffAsset(Buffer.concat([Buffer.from("ID3"), Buffer.alloc(20)]))?.ext, "mp3");
  assert.equal(sniffAsset(mp4())?.kind, "video");
  assert.equal(sniffAsset(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(8)]))?.kind, "audio");
  assert.equal(sniffAsset(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(20)]))?.kind, "font");
  assert.equal(sniffAsset(Buffer.from([0, 1, 0, 0, 0, 0]))?.ext, "ttf");
  assert.equal(sniffAsset(Buffer.from("just some text")), null);
  assert.equal(sniffAsset(Buffer.from("<html><script>x</script></html>")), null);
});

test("the asset dictionary stores, describes, matches and removes assets", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "assets-"));
  const assets = new Assets(dir);
  const logo = assets.add({ name: "Gamface logo", description: "Yellow G on black", tags: [], data: `data:image/png;base64,${b64(PNG)}` });
  assert.ok(!("error" in logo));
  if ("error" in logo) return;
  assert.equal(logo.role, "logo");
  assert.match(logo.id, /^gamface-logo-[a-f0-9]{6}$/);
  // The first logo becomes the brand's
  assert.equal(assets.brand().logo, logo.id);
  const beach = assets.add({ name: "Beach sunset", description: "Wide shot of waves at golden hour", tags: ["Summer", "ocean"], data: b64(PNG) });
  const clip = assets.add({ name: "Arena crowd", description: "Fans cheering in the stands", tags: ["esports"], seconds: 8, data: b64(mp4()) });
  const song = assets.add({ name: "Lofi loop", description: "Chill beat", tags: [], seconds: 30, data: b64(wav(0.5)) });
  const font = assets.add({ name: "Brand font", tags: [], data: b64(Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(40)])) });
  for (const a of [beach, clip, song, font]) assert.ok(!("error" in a), JSON.stringify(a));
  if ("error" in beach || "error" in clip || "error" in song || "error" in font) return;
  assert.deepEqual(beach.tags, ["summer", "ocean"]);
  assert.equal(clip.role, "broll");
  assert.equal(song.role, "music");
  assert.equal(assets.brand().fontAsset, font.id);
  assert.ok(existsSync(path.join(dir, "assets", "files", publicName(beach))));

  // Matching: words, names, music only when asked; logo and fonts aren't picked
  assert.deepEqual(assets.pick("Make a summer promo with ocean shots").map((a) => a.id), [beach.id]);
  assert.deepEqual(assets.pick("an esports hype video of the arena crowd").map((a) => a.id), [clip.id]);
  assert.ok(assets.pick("promo with upbeat music").some((a) => a.id === song.id));
  assert.equal(assets.pick("a countdown timer").length, 0);
  assert.deepEqual(assets.brandAssets().map((a) => a.id).sort(), [logo.id, font.id].sort());

  // Bad uploads
  assert.match((assets.add({ name: "x", tags: [], data: b64(Buffer.from("hello world")) }) as { error: string }).error, /Supported/);

  // Edits and the brand
  assets.update(beach.id, { description: "Waves", tags: ["Beach"], role: "broll" });
  assert.equal(assets.get(beach.id)!.role, "picture"); // a picture can't be B-roll
  assert.deepEqual(assets.get(beach.id)!.tags, ["beach"]);
  assert.match((assets.setBrand({ ...assets.brand(), logo: song.id }) as { error: string }).error, /logo must be a picture/);
  assert.match((assets.setBrand({ ...assets.brand(), primary: "red" }) as { error: string }).error, /primary/);
  const b = assets.setBrand({ ...assets.brand(), name: "Gamface", accent: "#ff0055", font: "brand" });
  assert.ok(!("error" in b));
  assert.equal(assets.branded(), true);

  // It all survives a restart
  const again = new Assets(dir);
  assert.equal(again.list().length, 5);
  assert.equal(again.brand().name, "Gamface");
  // Deleting the logo clears it from the brand
  assert.ok(again.remove(logo.id));
  assert.equal(again.brand().logo, null);
  assert.ok(!existsSync(path.join(dir, "assets", "files", publicName(logo))));
  assert.equal(JSON.parse(readFileSync(path.join(dir, "assets", "index.json"), "utf8")).length, 4);
});

test("the asset block tells the Coder about assets, music, sounds and the brand", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "assets-"));
  const assets = new Assets(dir);
  const beach = assets.add({ name: "Beach", description: "Waves", tags: ["summer"], data: b64(PNG) });
  const song = assets.add({ name: "Lofi loop", tags: [], data: b64(wav(0.2)) });
  const whoosh = assets.add({ name: "Whoosh sfx", tags: [], data: b64(wav(0.1)) });
  if ("error" in beach || "error" in song || "error" in whoosh) throw new Error("add failed");
  assets.update(song.id, { tempo: 92, beats: [0.5, 1.15] });
  const brand = BrandSchema.parse({ name: "Gamface", tagline: "Play together" });
  const text = assetBlock([beach, assets.get(song.id)!, whoosh], brand);
  assert.match(text, /BRAND "Gamface"/);
  assert.match(text, new RegExp(`"${beach.id}": picture: Beach\\. Waves \\[summer\\]`));
  assert.match(text, /MUSIC: "Lofi loop" plays under the whole video automatically \(92 BPM\)/);
  assert.match(text, new RegExp(`SOUND EFFECT "${whoosh.id}"`));
  assert.equal(whoosh.role, "sound");
  assert.equal(assetBlock([], null), "");
});

test("the voice client speaks, caches, times words and finds beats", async () => {
  const calls: { url: string; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ url: req.url!, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, ready: true, voices: ["af_heart"], whisper: "base.en", error: null }));
      if (req.url === "/speak") {
        if (body.voice === "broken") return res.writeHead(500).end(JSON.stringify({ error: "RuntimeError: boom" }));
        return res.end(JSON.stringify({ audio: b64(wav(1)), seconds: 1, words: [{ text: "Hello", start: 0, end: 0.4 }], voice: body.voice }));
      }
      if (req.url === "/words") return res.end(JSON.stringify({ words: [{ text: "hi", start: 0.1, end: 0.3 }], seconds: 2, text: "hi" }));
      if (req.url === "/beats") return res.end(JSON.stringify({ tempo: 120, beats: [0.5, 1], seconds: 2 }));
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const v = new VoiceClient(base);
    assert.equal((await v.health())?.voices[0], "af_heart");
    const a = await v.speak("Hello", "af_heart", 1);
    assert.ok(!("error" in a));
    if (!("error" in a)) {
      assert.equal(a.wav.subarray(0, 4).toString(), "RIFF");
      assert.equal(a.words[0].text, "Hello");
    }
    await v.speak("Hello", "af_heart", 1);
    assert.equal(calls.filter((c) => c.url === "/speak").length, 1, "the same narration is spoken once");
    assert.match(((await v.speak("Hi", "broken")) as { error: string }).error, /boom/);
    const w = await v.words(wav(2), "hi");
    assert.ok(!("error" in w) && w.words[0].start === 0.1);
    assert.equal(calls.find((c) => c.url === "/words")!.body.text, "hi");
    const beats = await v.beats(wav(2));
    assert.ok(!("error" in beats) && beats.tempo === 120);
    const down = new VoiceClient("http://127.0.0.1:1");
    assert.match(((await down.speak("x", "af_heart")) as { error: string }).error, /isn't reachable/);
    assert.equal(await down.health(), null);
  } finally {
    server.close();
  }
});
