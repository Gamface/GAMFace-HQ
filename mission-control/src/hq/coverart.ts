// AI cover art: the Writer turns the book (brief, plan, genre, characters) into an art brief
// in a chosen style, and the picture tool (Z-Image Turbo in ComfyUI on this PC) draws a few
// options from it. The picture has no lettering: the title, subtitle and author are set in
// real type by the cover layout, so they are crisp, spelled right and inside KDP's margins.

import type { ChatMessage } from "./ollama";
import type { Palette } from "./palettes";

export const COVER_STYLES = [
  { id: "auto", name: "Best for the book", look: "" },
  { id: "photo", name: "Photographic", look: "cinematic photograph, shot on a full-frame camera with a 50mm lens, dramatic natural light, rich detail, photorealistic, shallow depth of field" },
  { id: "painted", name: "Painted", look: "rich digital oil painting, visible painterly brushwork, dramatic lighting, highly detailed, epic book cover art" },
  { id: "illustrated", name: "Illustrated", look: "detailed digital illustration, clean confident linework, vibrant colour, polished commercial book cover illustration" },
  { id: "graphic", name: "Graphic poster", look: "bold graphic design poster, flat vector shapes, a strong central silhouette, limited colour palette, mid-century modern, crisp edges" },
  { id: "minimal", name: "Minimal symbol", look: "minimalist still life of a single symbolic object, lots of clean negative space, soft studio light, elegant and modern" },
  { id: "atmospheric", name: "Dark & atmospheric", look: "moody atmospheric scene, chiaroscuro lighting, fog and deep shadows, cinematic, mysterious" },
  { id: "vintage", name: "Vintage paperback", look: "vintage 1960s paperback cover art, gouache painting, halftone print texture, slightly faded colours" },
  { id: "watercolour", name: "Watercolour", look: "loose expressive watercolour painting, soft washes and paper texture, gentle light" },
  { id: "storybook", name: "Storybook", look: "children's picture book illustration, warm, friendly and soft, gentle shapes" },
] as const;
export type CoverStyle = (typeof COVER_STYLES)[number]["id"];
export const coverStyle = (id: unknown) => COVER_STYLES.find((s) => s.id === id);

/** What a cover picture must never have, whatever the brief says. */
export const NO_TEXT = "No text, no letters, no words, no title, no typography, no logos, no watermark, no signature, no border, no frame, not a book mockup.";

/** Composition that leaves room for the type, by layout. */
const ROOM: Record<string, string> = {
  bands: "Keep the top fifth and the bottom sixth calm and uncluttered (the title and author go there); the main subject sits in the middle.",
  bottom: "Keep the lower third calm and uncluttered (the title goes there); the main subject sits in the upper middle.",
  top: "Keep the upper third calm and uncluttered, like open sky or a plain wall (the title goes there); the main subject sits in the lower middle.",
  frame: "Keep the lower third fairly simple (a title panel covers it); the main subject sits in the upper half.",
  split: "Frame the main subject in the centre with room around it; the picture is cropped to its top two thirds.",
};

// Rough colour names, so the image model can follow the book's palette
const NAMES: [number, string][] = [
  [12, "red"],
  [35, "orange"],
  [50, "amber"],
  [68, "yellow"],
  [155, "green"],
  [200, "teal"],
  [250, "blue"],
  [280, "indigo"],
  [320, "purple"],
  [345, "magenta"],
  [360, "red"],
];
export function colourName(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  if (s < 0.12) return l < 0.15 ? "black" : l > 0.88 ? "white" : l < 0.4 ? "charcoal grey" : l > 0.7 ? "pale grey" : "grey";
  const h = max === r ? ((g - b) / (max - min) + 6) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
  const hue = NAMES.find(([lim]) => h * 60 <= lim)![1];
  const tone = l < 0.22 ? "deep " : l < 0.4 ? "dark " : l > 0.8 ? "pale " : l > 0.65 ? "light " : "";
  return `${tone}${hue}`;
}

export interface CoverBriefInput {
  title: string;
  subtitle?: string;
  kind: string;
  genre: string;
  audience: string;
  brief: string;
  bible: string;
  art?: { style: string; characters: string };
  listing?: { backCover?: string };
}

export interface CoverRequest {
  style: CoverStyle;
  /** What you want on it, in your words ("a lighthouse in a storm") */
  note?: string;
  layout?: string;
  /** Ask for these colours in the picture */
  colors?: Palette;
}

/** Asks the Writer for an art brief: one strong image, described for the picture model. */
export function coverBriefPrompt(book: CoverBriefInput, req: CoverRequest): ChatMessage[] {
  const style = coverStyle(req.style);
  const kind = book.kind === "novel" ? "novel" : book.kind === "picture" ? "children's picture book" : book.kind === "puzzle" ? "puzzle book" : "nonfiction book";
  const look = req.style === "auto" ? "Choose the style that the bestselling covers in this genre use (photographic, painted, illustrated, graphic or minimal) and name it in the prompt." : `Style: ${style?.look}.`;
  const picture = book.kind === "picture" && book.art ? `\nThe book's art style (use it): ${book.art.style}\nCharacters, exactly as drawn inside: ${book.art.characters}` : "";
  return [
    {
      role: "system",
      content:
        "You are an art director for book covers. You write one prompt for an AI image model: a single striking, genre-right image that reads at thumbnail size. " +
        "Describe what is seen, not what it means: subject, setting, composition, lighting, colour and style, in concrete visual words. Reply with JSON only.",
    },
    {
      role: "user",
      content:
        `A ${kind}: ${book.title || "untitled"}${book.subtitle ? ` — ${book.subtitle}` : ""}\n` +
        (book.genre ? `Genre/topic: ${book.genre}\n` : "") +
        (book.audience ? `Audience: ${book.audience}\n` : "") +
        `Brief: ${book.brief.slice(0, 1500)}\n` +
        (book.bible ? `Plan:\n${book.bible.slice(0, 2500)}\n` : "") +
        (book.listing?.backCover ? `Back cover: ${book.listing.backCover.slice(0, 800)}\n` : "") +
        picture +
        (req.note ? `\nThe author wants: ${req.note.slice(0, 600)}\n` : "\n") +
        `\nWrite the image prompt (60–110 words). ${look} A vertical 2:3 book cover composition. ${ROOM[req.layout ?? "bands"] ?? ROOM.bands} ` +
        (req.colors ? `Use a colour scheme of ${colourName(req.colors.bg)} and ${colourName(req.colors.accent)}. ` : "") +
        `Don't show a book, a person reading, or any text, letters, signs or logos. Avoid clichés unless the genre demands them.\n` +
        `Reply as {"prompt": "…", "concept": "the idea in under 12 words"}`,
    },
  ];
}

/** The art brief from the Writer's reply, with the no-text rule added. */
export function parseCoverBrief(json: Record<string, unknown>): { prompt: string; concept: string } | { error: string } {
  const prompt = typeof json.prompt === "string" ? json.prompt.replace(/\s+/g, " ").trim() : "";
  if (prompt.split(" ").length < 8) return { error: "The art brief came back empty" };
  const concept = typeof json.concept === "string" ? json.concept.trim().slice(0, 120) : "";
  return { prompt: finishPrompt(prompt), concept };
}

/** Adds the composition and no-text rules, and keeps it within the picture tool's 1500 characters. */
export function finishPrompt(prompt: string, layout = "bands"): string {
  const tail = ` Vertical book cover art. ${NO_TEXT}`;
  let p = prompt.replace(/\s+/g, " ").trim();
  if (!/no text/i.test(p)) p += tail;
  if (!/top|bottom|lower|upper|negative space|uncluttered/i.test(p) && ROOM[layout]) p = `${p} ${ROOM[layout]}`;
  return p.slice(0, 1490);
}

/** A brief without the Writer (when it can't be reached, or for a quick start). */
export function fallbackBrief(book: CoverBriefInput, req: CoverRequest): string {
  const style = req.style === "auto" ? (book.kind === "picture" ? coverStyle("storybook")! : coverStyle("painted")!) : coverStyle(req.style)!;
  const subject = req.note?.trim() || book.brief.split(/(?<=[.!?])\s/)[0].slice(0, 300);
  const look = book.kind === "picture" && book.art?.style ? book.art.style : style.look;
  const colours = req.colors ? ` Colour scheme: ${colourName(req.colors.bg)} and ${colourName(req.colors.accent)}.` : "";
  const chars = book.kind === "picture" && book.art?.characters ? ` ${book.art.characters}` : "";
  return finishPrompt(`Book cover for a ${book.genre || book.kind}: ${subject}.${chars} ${look}.${colours}`, req.layout);
}

/** Front-cover pixels for 300 dpi print at a trim (with bleed on the outside edge, top and bottom), capped for size. */
export function printPixels(trim: [number, number], max = 3400): [number, number] {
  const [w, h] = [trim[0] + 0.125, trim[1] + 0.25];
  const scale = Math.min(300, max / Math.max(w, h));
  return [Math.round(w * scale), Math.round(h * scale)];
}
