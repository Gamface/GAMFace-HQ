// Cover typography: font pairs (a title face and a text face) embedded in the cover so the
// browser sidecar, which has no network, prints them exactly; and front-cover layouts that
// place the title and author over a picture. All fonts are SIL Open Font License (OFL-1.1),
// from the @fontsource packages, so they can go on a book you sell.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { PaletteGroup } from "./palettes";

interface Face {
  /** The @fontsource package name after the scope */
  pkg: string;
  family: string;
  weights: number[];
  italic?: boolean;
}

const FACES = {
  playfair: { pkg: "playfair-display", family: "Playfair Display", weights: [400, 700], italic: true },
  lora: { pkg: "lora", family: "Lora", weights: [400, 700], italic: true },
  montserrat: { pkg: "montserrat", family: "Montserrat", weights: [400, 700] },
  oswald: { pkg: "oswald", family: "Oswald", weights: [400, 600] },
  bebas: { pkg: "bebas-neue", family: "Bebas Neue", weights: [400] },
  cinzel: { pkg: "cinzel", family: "Cinzel", weights: [400, 700] },
  cormorant: { pkg: "cormorant-garamond", family: "Cormorant Garamond", weights: [400, 600], italic: true },
  fredoka: { pkg: "fredoka", family: "Fredoka", weights: [400, 600] },
  elite: { pkg: "special-elite", family: "Special Elite", weights: [400] },
  vibes: { pkg: "great-vibes", family: "Great Vibes", weights: [400] },
} satisfies Record<string, Face>;
type FaceId = keyof typeof FACES;

export interface FontPair {
  id: string;
  name: string;
  title: { face: FaceId; weight: number; upper?: boolean; spacing?: string; italic?: boolean; scale?: number };
  text: { face: FaceId; weight: number };
  /** The author line: in the text face unless set */
  author?: { face: FaceId; weight: number; upper?: boolean; spacing?: string; scale?: number };
}

export const FONT_PAIRS: FontPair[] = [
  { id: "classic", name: "Classic serif", title: { face: "playfair", weight: 700 }, text: { face: "lora", weight: 400 } },
  { id: "elegant", name: "Elegant", title: { face: "cormorant", weight: 600, scale: 1.15 }, text: { face: "cormorant", weight: 400 }, author: { face: "cormorant", weight: 600, upper: true, spacing: "0.18em" } },
  { id: "romance", name: "Romantic script", title: { face: "vibes", weight: 400, scale: 1.35 }, text: { face: "lora", weight: 400 }, author: { face: "montserrat", weight: 400, upper: true, spacing: "0.25em", scale: 0.8 } },
  { id: "thriller", name: "Thriller", title: { face: "oswald", weight: 600, upper: true, spacing: "0.04em", scale: 1.15 }, text: { face: "lora", weight: 400 }, author: { face: "oswald", weight: 400, upper: true, spacing: "0.2em" } },
  { id: "bold", name: "Bold display", title: { face: "bebas", weight: 400, upper: true, spacing: "0.03em", scale: 1.45 }, text: { face: "montserrat", weight: 400 }, author: { face: "bebas", weight: 400, upper: true, spacing: "0.12em", scale: 1.2 } },
  { id: "epic", name: "Epic", title: { face: "cinzel", weight: 700, upper: true, spacing: "0.06em" }, text: { face: "lora", weight: 400 }, author: { face: "cinzel", weight: 400, upper: true, spacing: "0.15em" } },
  { id: "modern", name: "Modern sans", title: { face: "montserrat", weight: 700, spacing: "-0.01em" }, text: { face: "montserrat", weight: 400 }, author: { face: "montserrat", weight: 400, upper: true, spacing: "0.2em", scale: 0.85 } },
  { id: "playful", name: "Playful", title: { face: "fredoka", weight: 600, scale: 1.1 }, text: { face: "fredoka", weight: 400 } },
  { id: "typewriter", name: "Typewriter", title: { face: "elite", weight: 400 }, text: { face: "elite", weight: 400 } },
  { id: "literary", name: "Literary italic", title: { face: "playfair", weight: 400, italic: true, scale: 1.1 }, text: { face: "lora", weight: 400 }, author: { face: "lora", weight: 400, upper: true, spacing: "0.16em", scale: 0.85 } },
];
const PAIR_BY_ID = new Map(FONT_PAIRS.map((f) => [f.id, f]));
export const fontPairById = (id: string | undefined) => (id ? PAIR_BY_ID.get(id) : undefined);

/** Where the title and author sit on a front cover with a picture */
export const LAYOUTS = ["bands", "bottom", "top", "frame", "split"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const LAYOUT_LABEL: Record<Layout, string> = {
  bands: "Title band at the top, author at the bottom",
  bottom: "Big title at the bottom, author at the top",
  top: "Big title at the top over a fade",
  frame: "Title in a framed panel",
  split: "Picture above, title block below",
};

/** A font pair for a genre group, when the book hasn't chosen one. */
const GROUP_FONTS: Partial<Record<PaletteGroup, string>> = {
  romance: "romance",
  thriller: "thriller",
  mystery: "thriller",
  fantasy: "epic",
  historical: "epic",
  scifi: "modern",
  horror: "bold",
  literary: "literary",
  children: "playful",
  teen: "bold",
  nonfiction: "modern",
  business: "modern",
  selfhelp: "bold",
  wellness: "elegant",
  cookbook: "classic",
  nature: "elegant",
  travel: "modern",
  faith: "elegant",
  poetry: "literary",
  seasonal: "classic",
  vintage: "typewriter",
  bold: "bold",
  pastel: "playful",
  mono: "modern",
};
export const fontsForGroup = (group: PaletteGroup | undefined) => fontPairById(group ? GROUP_FONTS[group] : undefined) ?? FONT_PAIRS[0];

// --- Embedding ---------------------------------------------------------------------------

const fontCache = new Map<string, string | null>();

/** A font file as a data: URI, or null when the package isn't installed (the cover then falls back to Georgia). */
function fontData(face: Face, weight: number, italic: boolean): string | null {
  const key = `${face.pkg}-${weight}-${italic}`;
  if (fontCache.has(key)) return fontCache.get(key)!;
  let uri: string | null = null;
  try {
    const dir = path.dirname(require.resolve(`@fontsource/${face.pkg}/package.json`));
    const buf = readFileSync(path.join(dir, "files", `${face.pkg}-latin-${weight}-${italic ? "italic" : "normal"}.woff2`));
    uri = `data:font/woff2;base64,${buf.toString("base64")}`;
  } catch {
    uri = null;
  }
  fontCache.set(key, uri);
  return uri;
}

const nearest = (face: Face, w: number) => face.weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));

/** @font-face rules for a pair (only the weights it uses), and its CSS font stacks. */
export function fontCss(pair: FontPair): { faces: string; title: string; text: string; author: string } {
  const used = new Map<string, { face: Face; weight: number; italic: boolean }>();
  const want = (id: FaceId, weight: number, italic = false) => {
    const face: Face = FACES[id];
    const w = nearest(face, weight);
    const it = italic && Boolean(face.italic);
    used.set(`${id}-${w}-${it}`, { face, weight: w, italic: it });
  };
  want(pair.title.face, pair.title.weight, pair.title.italic);
  want(pair.text.face, pair.text.weight);
  want(pair.text.face, pair.text.weight, true);
  if (pair.author) want(pair.author.face, pair.author.weight);
  const faces = [...used.values()]
    .map(({ face, weight, italic }) => {
      const src = fontData(face, weight, italic);
      return src ? `@font-face { font-family: "${face.family}"; font-style: ${italic ? "italic" : "normal"}; font-weight: ${weight}; src: url(${src}) format("woff2"); }` : "";
    })
    .join("\n");
  const stack = (id: FaceId) => `"${FACES[id].family}", Georgia, "Times New Roman", serif`;
  return { faces, title: stack(pair.title.face), text: stack(pair.text.face), author: stack((pair.author ?? pair.text).face) };
}

/** The font pairs as the Books page lists them. */
export const fontPairList = () => FONT_PAIRS.map((f) => ({ id: f.id, name: f.name, title: FACES[f.title.face].family, text: FACES[f.text.face].family }));
