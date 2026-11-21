import assert from "node:assert/strict";
import { test } from "node:test";
import { galleryItems, galleryKind, suggestedName } from "../src/hq/gallery";

const files = [
  { name: "images-a-red-fox-in-the-snow-1a2b3c4d.png", bytes: 1000, at: 3 },
  { name: "inspo-search-screens-81b82520.webp", bytes: 500, at: 2 },
  { name: "launch-video-0f0f0f0f.mp4", bytes: 9000, at: 1 },
  { name: "weekly-report-12345678.pdf", bytes: 200, at: 0 },
  { name: "orphan-picture-abcdef12.jpg", bytes: 300, at: 0 },
];
const cards = [
  { id: "c1", prompt: "make a picture of a fox", title: "Fox picture", files: [{ name: "images-a-red-fox-in-the-snow-1a2b3c4d.png" }, { name: "weekly-report-12345678.pdf" }] },
  { id: "c2", prompt: "design inspiration", project: "arts-1a2b", files: [{ name: "inspo-search-screens-81b82520.webp" }] },
  { id: "c3", prompt: "launch video", files: [{ name: "launch-video-0f0f0f0f.mp4" }] },
  // A subtask's copy doesn't decide the owner; its parent card does
  { id: "s1", parentId: "c3", prompt: "render", project: "arts-1a2b", files: [{ name: "launch-video-0f0f0f0f.mp4" }] },
];

test("the gallery lists pictures and clips (not PDFs), with their card and asset", () => {
  const all = galleryItems(files, cards, [{ id: "red-fox-abc123", source: "images-a-red-fox-in-the-snow-1a2b3c4d.png" }, { id: "logo-def456" }], undefined);
  assert.deepEqual(
    all.map((i) => [i.name, i.kind, i.card?.id ?? null, i.asset ?? null]),
    [
      ["images-a-red-fox-in-the-snow-1a2b3c4d.png", "image", "c1", "red-fox-abc123"],
      ["inspo-search-screens-81b82520.webp", "image", "c2", null],
      ["launch-video-0f0f0f0f.mp4", "video", "c3", null],
      ["orphan-picture-abcdef12.jpg", "image", null, null],
    ],
  );
  assert.equal(all[0].card?.title, "Fox picture");
  assert.equal(all[1].card?.title, "design inspiration", "no title: the prompt");
});

test("a project's gallery shows its cards' files; General shows the rest", () => {
  assert.deepEqual(
    galleryItems(files, cards, [], "arts-1a2b").map((i) => i.name),
    ["inspo-search-screens-81b82520.webp"],
  );
  assert.deepEqual(
    galleryItems(files, cards, [], null).map((i) => i.name),
    ["images-a-red-fox-in-the-snow-1a2b3c4d.png", "launch-video-0f0f0f0f.mp4", "orphan-picture-abcdef12.jpg"],
  );
});

test("file names become readable asset names", () => {
  assert.equal(suggestedName("images-a-red-fox-in-the-snow-1a2b3c4d.png"), "A red fox in the snow");
  assert.equal(suggestedName("inspo-search-screens-81b82520.webp"), "Picture");
  assert.equal(suggestedName("launch-video-0f0f0f0f.mp4"), "Launch video");
  assert.equal(galleryKind("x-12345678.pdf"), null);
  assert.equal(galleryKind("x-12345678.mp4"), "video");
});
