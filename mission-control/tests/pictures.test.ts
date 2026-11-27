import assert from "node:assert/strict";
import { test } from "node:test";
import { FILE_ID, fileType } from "../src/hq/pdf";
import type { JsonChat } from "../src/hq/ollama";
import { keywordRoute, routeTask, setToolsSummary, wantsCodeOrGitHub, wantsDesignReferences, wantsPicture } from "../src/hq/team";
import { toolMedia } from "../src/hq/tools";

const never: JsonChat = async () => {
  throw new Error("the router model shouldn't be asked");
};

test("asking for a new picture is told apart from asking about one", () => {
  for (const p of ["Create a photo of the sunrise", "make me a picture of a red fox", "draw a logo for my band", "Can you generate an image of Mars at dusk?", "paint a portrait of my dog"])
    assert.equal(wantsPicture(p), true, p);
  for (const p of ["What's in this photo?", "read the screenshot", "describe the image I attached", "make the code faster", "create a script that resizes images"])
    assert.equal(wantsPicture(p), false, p);
  // Graphics count as pictures too
  for (const p of ["create a flyer for the gamface brand", "design a banner for our YouTube channel", "make a thumbnail for the new video", "generate album cover art", "draw a mascot for the team", "make a sticker of a fox"])
    assert.equal(wantsPicture(p), true, p);
  for (const p of ["create a cover letter for the job", "write the text for a flyer", "make the background job faster", "create a component for the banner"]) assert.equal(wantsPicture(p), false, p);
  // Making one again counts too ("remake this book cover" went to Vision, which can't make pictures)
  for (const p of ["remake this book cover", "redo the cover", "Recreate this photo in watercolour", "regenerate the logo", "redesign my book cover", "make a new cover"]) assert.equal(wantsPicture(p), true, p);
  for (const p of ["make sure the tests cover the edge cases", "redo the cover letter", "does insurance cover this photo damage?", "regenerate the report"]) assert.equal(wantsPicture(p), false, p);
});

test("picture requests go to the picture tool, or to Jarvis when there isn't one, never to Vision", async () => {
  try {
    setToolsSummary(null);
    assert.equal(keywordRoute("Create a photo of the sunrise"), "planner");
    assert.equal((await routeTask(never, "m", "Create a photo of the sunrise")).agent, "planner");
    setToolsSummary("wikipedia: search (Search Wikipedia)");
    assert.equal(keywordRoute("Create a photo of the sunrise"), "planner", "tools installed, but none makes pictures");
    setToolsSummary("images: generate_image (Make a new picture from a text description)");
    assert.equal(keywordRoute("Create a photo of the sunrise"), "tools");
    assert.deepEqual(await routeTask(never, "m", "Create a photo of the sunrise"), { agent: "tools", reason: "make a picture" });
    assert.equal(keywordRoute("What's in this photo?"), "vision", "reading a picture still goes to Vision");
  } finally {
    setToolsSummary(null);
  }
});

test("questions about HQ's own code or GitHub go to the Tools agent when those tools are installed", async () => {
  for (const p of ["Check your own code for TODOs", "How does Mission Control's code route requests?", "any open pull requests on GitHub?", "what were the last commits?", "search your repository for the word privacy"])
    assert.equal(wantsCodeOrGitHub(p), true, p);
  for (const p of ["fix the bug in my code", "write a python script", "commit to the plan", "what's the weather"]) assert.equal(wantsCodeOrGitHub(p), false, p);
  try {
    setToolsSummary("wikipedia: search (Search Wikipedia)");
    assert.equal(keywordRoute("Check your own code for TODOs"), "coder", "no code tools: the Coder, as before");
    // Installed tool names count even when the summary was cut short
    setToolsSummary("espn: scores (Scores)", ["espn.scores", "code.search_code", "github.list_pull_requests"]);
    assert.equal(keywordRoute("Check your own code for TODOs"), "tools");
    assert.deepEqual(await routeTask(never, "m", "any open pull requests on GitHub?"), { agent: "tools", reason: "Mission Control's code or GitHub" });
  } finally {
    setToolsSummary(null);
  }
});

test("pictures and clips from the tools service: only well-formed PNG, JPEG, WebP or MP4, at most four", () => {
  const png = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  const mp4 = { mimeType: "video/mp4", data: "AAAAIGZ0eXA=" };
  assert.deepEqual(toolMedia([png, mp4]), [png, mp4]);
  assert.deepEqual(toolMedia([{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }, { mimeType: "video/webm", data: "AAAA" }, { mimeType: "image/png", data: "not base64!" }, null, "x"]), []);
  assert.equal(toolMedia(Array(6).fill(png)).length, 4);
  assert.deepEqual(toolMedia(undefined), []);
});
test("saved pictures are card files with the right type", () => {
  assert.ok(FILE_ID.test("images-a-sunrise-over-the-sea-1a2b3c4d.png"));
  assert.ok(FILE_ID.test("x-1a2b3c4d.jpg") && FILE_ID.test("x-1a2b3c4d.webp") && FILE_ID.test("images-a-fox-in-the-snow-1a2b3c4d.mp4"));
  assert.ok(!FILE_ID.test("x-1a2b3c4d.svg") && !FILE_ID.test("../x-1a2b3c4d.png"));
  assert.equal(fileType("a-1a2b3c4d.png"), "image/png");
  assert.equal(fileType("a-1a2b3c4d.jpg"), "image/jpeg");
  assert.equal(fileType("a-1a2b3c4d.mp4"), "video/mp4");
  assert.equal(fileType("a-1a2b3c4d.pdf"), "application/pdf");
});

test("design reference requests go to the Tools agent when Inspo is installed", async () => {
  for (const p of ["Find design inspiration for a youth arts landing page", "show me UI references for a dark dashboard", "I need inspo for the homepage", "what should the landing page look like?", "landing page examples for a music school"])
    assert.equal(wantsDesignReferences(p), true, p);
  for (const p of ["build a landing page for the youth arts program", "make the code faster", "cite your references for that claim", "design a logo"]) assert.equal(wantsDesignReferences(p), false, p);
  try {
    setToolsSummary("wikipedia: search (Search Wikipedia)", ["wikipedia.search"]);
    assert.notEqual(keywordRoute("Find design inspiration for a youth arts landing page"), "tools", "no Inspo: not the Tools agent");
    setToolsSummary("inspo: recommend (…)", ["inspo.recommend", "inspo.get_screen"]);
    assert.equal(keywordRoute("Find design inspiration for a youth arts landing page"), "tools");
    assert.deepEqual(await routeTask(never, "m", "show me UI references for a dark dashboard"), { agent: "tools", reason: "design references" });
  } finally {
    setToolsSummary(null);
  }
});
