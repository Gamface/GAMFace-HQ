// Book cover colours: a library of named palettes, the book's own choice (a palette, your
// brand kit, three colours of your own, or colours taken from the cover picture), automatic
// picks from the book's genre and brief, and contrast checks so the text stays readable.
//
// A palette is three colours: the background (back cover and plain front), the accent
// (spine, headings, rules) and the text. The spine prints its title in the background
// colour on the accent, so that pair has to read as well.

import { inflateSync } from "zlib";

export interface Palette {
  bg: string;
  fg: string;
  accent: string;
}

export interface NamedPalette extends Palette {
  id: string;
  name: string;
  group: PaletteGroup;
  /** Words in a genre or brief that suit it */
  tags: string[];
}

/** Where a book's colours came from */
export type ColorSource = "preset" | "custom" | "brand" | "picture" | "auto" | "writer";

export interface CoverColors extends Palette {
  source: ColorSource;
  /** The preset's id, when it is one */
  palette?: string;
  /** Kept as they are: automation (genre, picture, the Writer) leaves them alone */
  locked?: boolean;
  /** How the title band sits on a cover picture */
  band?: BandStyle;
}

/** The title band over a cover picture: tinted with the palette, the old dark band, or no band (text shadow only) */
export type BandStyle = "palette" | "dark" | "none";
export const BAND_STYLES: BandStyle[] = ["palette", "dark", "none"];

export const PALETTE_GROUPS = [
  "classic",
  "romance",
  "thriller",
  "mystery",
  "fantasy",
  "scifi",
  "horror",
  "literary",
  "historical",
  "children",
  "teen",
  "nonfiction",
  "business",
  "selfhelp",
  "wellness",
  "cookbook",
  "nature",
  "travel",
  "faith",
  "poetry",
  "seasonal",
  "vintage",
  "bold",
  "pastel",
  "mono",
] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

export const GROUP_LABEL: Record<PaletteGroup, string> = {
  classic: "Classic",
  romance: "Romance",
  thriller: "Thriller & suspense",
  mystery: "Mystery & crime",
  fantasy: "Fantasy",
  scifi: "Science fiction",
  horror: "Horror & dark",
  literary: "Literary",
  historical: "Historical",
  children: "Children's",
  teen: "Teen & young adult",
  nonfiction: "Nonfiction",
  business: "Business & money",
  selfhelp: "Self-help",
  wellness: "Health & wellness",
  cookbook: "Food & cooking",
  nature: "Nature & outdoors",
  travel: "Travel",
  faith: "Faith & spirit",
  poetry: "Poetry & art",
  seasonal: "Holidays & seasons",
  vintage: "Vintage & retro",
  bold: "Bold & bright",
  pastel: "Soft pastels",
  mono: "Black, white & grey",
};

/** Words that point at a whole group (on top of each palette's own tags) */
const GROUP_TAGS: Record<PaletteGroup, string[]> = {
  classic: ["classic", "timeless", "elegant", "general"],
  romance: ["romance", "romantic", "love", "lovers", "wedding", "bride", "heart", "kiss", "rom-com", "romcom", "billionaire", "dating"],
  thriller: ["thriller", "suspense", "spy", "espionage", "conspiracy", "assassin", "heist", "action", "chase", "military", "techno-thriller"],
  mystery: ["mystery", "detective", "crime", "murder", "whodunit", "sleuth", "noir", "police", "investigation", "cozy", "cosy"],
  fantasy: ["fantasy", "magic", "wizard", "witch", "dragon", "elf", "elves", "fae", "fairy", "sword", "quest", "kingdom", "sorcery", "myth"],
  scifi: ["science fiction", "sci-fi", "scifi", "space", "galaxy", "alien", "robot", "cyberpunk", "future", "dystopian", "starship", "android", "ai"],
  horror: ["horror", "haunted", "ghost", "vampire", "zombie", "demon", "occult", "gothic", "creepy", "dark", "monster", "nightmare"],
  literary: ["literary", "literature", "family saga", "coming of age", "memoir", "drama", "contemporary", "women's fiction", "book club"],
  historical: ["historical", "history", "victorian", "regency", "medieval", "war", "ww2", "wwii", "tudor", "ancient", "civil war", "1920s"],
  children: ["children", "children's", "kids", "kid", "picture book", "toddler", "preschool", "bedtime", "nursery", "ages 3", "ages 4", "early reader"],
  teen: ["teen", "young adult", "ya", "high school", "academy", "middle grade"],
  nonfiction: ["nonfiction", "non-fiction", "guide", "how to", "how-to", "handbook", "reference", "textbook", "science", "education", "learn"],
  business: ["business", "money", "finance", "investing", "marketing", "sales", "startup", "entrepreneur", "leadership", "career", "productivity", "management", "wealth"],
  selfhelp: ["self-help", "self help", "personal growth", "motivation", "mindset", "habits", "confidence", "success", "relationships", "parenting"],
  wellness: ["health", "wellness", "fitness", "yoga", "meditation", "mindfulness", "nutrition", "diet", "sleep", "healing", "mental health", "anxiety"],
  cookbook: ["cookbook", "recipe", "recipes", "cooking", "baking", "food", "kitchen", "vegan", "dessert", "bread", "grill"],
  nature: ["nature", "outdoors", "garden", "gardening", "forest", "wildlife", "birds", "plants", "hiking", "camping", "environment", "climate"],
  travel: ["travel", "adventure", "journey", "road trip", "beach", "island", "ocean", "sea", "sailing", "explore"],
  faith: ["faith", "christian", "devotional", "prayer", "bible", "spiritual", "spirituality", "church", "god", "soul", "inspirational"],
  poetry: ["poetry", "poems", "poem", "verse", "haiku", "art", "artist", "photography", "design", "journal"],
  seasonal: ["christmas", "holiday", "halloween", "easter", "valentine", "thanksgiving", "winter", "summer", "autumn", "fall", "spring", "new year"],
  vintage: ["vintage", "retro", "nostalgia", "1950s", "1960s", "1970s", "1980s", "pulp", "western", "cowboy"],
  bold: ["bold", "bright", "fun", "activity", "puzzle", "puzzles", "word search", "sudoku", "games", "comedy", "humor", "humour", "party"],
  pastel: ["soft", "gentle", "pastel", "baby", "sweet", "cute", "calm", "dreamy", "coloring", "colouring"],
  mono: ["minimal", "minimalist", "black and white", "monochrome", "stark", "modern", "philosophy", "essay", "essays"],
};

const p = (id: string, name: string, group: PaletteGroup, bg: string, fg: string, accent: string, tags: string[] = []): NamedPalette => ({ id, name, group, bg, fg, accent, tags });

/**
 * The palette library. The first five are the original title-picked palettes, in their
 * original order: books that never chose colours keep printing with the same ones.
 */
export const PALETTES: NamedPalette[] = [
  // Classic (the first five are the originals)
  p("classic-navy", "Navy and gold", "classic", "#1f2a44", "#f5efe0", "#d9a441", ["navy", "gold", "academic"]),
  p("classic-forest", "Forest and brass", "classic", "#2d3a2e", "#f2f0e6", "#c9b26b", ["green", "brass"]),
  p("classic-wine", "Wine and amber", "classic", "#5b1f2a", "#fbf3ea", "#e8b86d", ["wine", "burgundy", "red"]),
  p("classic-parchment", "Parchment and rust", "classic", "#f3ead8", "#2b2b2b", "#a6452b", ["parchment", "cream", "light"]),
  p("classic-teal", "Deep teal and seafoam", "classic", "#123c4a", "#eef6f5", "#7fc8c2", ["teal", "sea"]),
  p("classic-charcoal", "Charcoal and champagne", "classic", "#2a2a2e", "#f4f1ea", "#cdb27a", ["charcoal", "grey"]),
  p("classic-oxford", "Oxford blue and silver", "classic", "#14213d", "#f1f3f7", "#a9b4c2", ["blue", "silver", "university"]),
  // Romance
  p("romance-blush", "Blush and rose gold", "romance", "#f7e1e1", "#3b2328", "#b5525c", ["blush", "pink", "sweet romance"]),
  p("romance-rouge", "Rouge", "romance", "#7a1f35", "#fff1f3", "#f2a7b5", ["passion", "red", "steamy"]),
  p("romance-midnight", "Midnight kiss", "romance", "#241a3a", "#f8eef6", "#e58fb4", ["night", "purple", "paranormal romance"]),
  p("romance-peony", "Peony", "romance", "#fbeaf0", "#4a2338", "#c2386f", ["floral", "rom-com", "flowers"]),
  p("romance-lilac", "Lilac dusk", "romance", "#e9e0f3", "#2e2340", "#8a5aa8", ["lilac", "lavender", "purple"]),
  // Thriller
  p("thriller-steel", "Steel and signal red", "thriller", "#1b1e23", "#f2f2f2", "#e63946", ["steel", "red", "action"]),
  p("thriller-amber", "Night and amber", "thriller", "#101418", "#f0ece4", "#f4a020", ["amber", "night"]),
  p("thriller-ice", "Ice cold", "thriller", "#0e1c26", "#eaf4f8", "#58c4dd", ["cold", "ice", "techno-thriller"]),
  p("thriller-olive", "Field olive", "thriller", "#2b2f1f", "#efeee6", "#d4b24c", ["military", "olive", "war"]),
  // Mystery
  p("mystery-noir", "Noir", "mystery", "#121212", "#f2efe9", "#c9a227", ["noir", "black", "hardboiled"]),
  p("mystery-cozy", "Cozy cottage", "mystery", "#f4ecdf", "#2f2a26", "#9c4a2f", ["cozy", "cosy", "cottage", "village", "cat"]),
  p("mystery-fog", "London fog", "mystery", "#2f3a40", "#eef1f2", "#d9b26f", ["fog", "london", "victorian"]),
  p("mystery-poison", "Poison green", "mystery", "#13261d", "#eef5ee", "#8fd16a", ["poison", "green"]),
  // Fantasy
  p("fantasy-dragon", "Dragonfire", "fantasy", "#2a0f0f", "#fbefe3", "#f08a24", ["dragon", "fire", "epic"]),
  p("fantasy-elven", "Elven wood", "fantasy", "#1d3324", "#f0f4e8", "#c8d97a", ["elf", "elven", "forest", "woodland"]),
  p("fantasy-arcane", "Arcane violet", "fantasy", "#24133d", "#f3ecfb", "#c9a7ff", ["arcane", "magic", "sorcery", "violet"]),
  p("fantasy-frost", "Frost kingdom", "fantasy", "#e6eef5", "#1b2a3a", "#3a6ea5", ["frost", "ice", "winter", "kingdom"]),
  p("fantasy-gilded", "Gilded court", "fantasy", "#3a1830", "#fbf1e6", "#e0b450", ["court", "royal", "crown", "gold", "romantasy"]),
  // Science fiction
  p("scifi-void", "Deep space", "scifi", "#0a0e1f", "#e8ecff", "#6f8cff", ["space", "stars", "galaxy"]),
  p("scifi-neon", "Neon city", "scifi", "#120a1f", "#f4ecff", "#ff3fa4", ["cyberpunk", "neon", "city"]),
  p("scifi-mars", "Red planet", "scifi", "#3b130c", "#fdeee6", "#ff8a4c", ["mars", "planet", "desert"]),
  p("scifi-terminal", "Terminal", "scifi", "#0b1410", "#e6f5ea", "#39d98a", ["hacker", "code", "computer", "ai"]),
  p("scifi-chrome", "Chrome", "scifi", "#d9dde3", "#15181d", "#2c5d8a", ["chrome", "robot", "android", "light"]),
  // Horror
  p("horror-blood", "Blood moon", "horror", "#140707", "#f3e6e6", "#c1121f", ["blood", "vampire", "slasher"]),
  p("horror-bone", "Bone and ash", "horror", "#e8e2d6", "#1a1714", "#6b0f1a", ["bone", "ash", "folk horror"]),
  p("horror-swamp", "Swamp", "horror", "#141a12", "#eaeee4", "#9bb84c", ["swamp", "zombie", "rot"]),
  p("horror-ghost", "Ghost light", "horror", "#1a1d24", "#eef0f5", "#a3b6d9", ["ghost", "haunted", "spirit"]),
  // Literary
  p("literary-linen", "Linen and ink", "literary", "#efe9df", "#1f1d1a", "#5a6b7a", ["linen", "quiet"]),
  p("literary-ochre", "Ochre", "literary", "#2c2620", "#f6efe4", "#d79a3b", ["ochre", "warm"]),
  p("literary-sage", "Sage", "literary", "#dfe5da", "#1f2a22", "#4f6b4f", ["sage", "green", "light"]),
  p("literary-plum", "Plum", "literary", "#3a2232", "#f7eef3", "#d9a3c2", ["plum", "family"]),
  // Historical
  p("historical-sepia", "Sepia", "historical", "#3b2a1e", "#f6ecdc", "#d3a76b", ["sepia", "old photo"]),
  p("historical-regency", "Regency", "historical", "#e9eef2", "#1d2733", "#7a4e6b", ["regency", "ball", "duke"]),
  p("historical-tudor", "Tudor", "historical", "#2a1418", "#f7ece0", "#c9a14a", ["tudor", "queen", "king"]),
  p("historical-wartime", "Wartime khaki", "historical", "#3a3a2a", "#f1efe4", "#c96a3a", ["war", "khaki", "ww2"]),
  // Children's
  p("children-sunshine", "Sunshine", "children", "#ffd84d", "#2b2b2b", "#d1495b", ["sun", "yellow", "happy"]),
  p("children-sky", "Sky blue", "children", "#bfe3ff", "#1d2b4a", "#c2412f", ["sky", "blue", "bedtime"]),
  p("children-meadow", "Meadow", "children", "#cfeec0", "#1f3320", "#b8501c", ["meadow", "animals", "farm"]),
  p("children-bubblegum", "Bubblegum", "children", "#ffd1e3", "#3a1f2c", "#7a3fd1", ["pink", "unicorn", "princess"]),
  p("children-night", "Starry bedtime", "children", "#1d2b5a", "#fff8e6", "#ffd166", ["bedtime", "night", "stars", "moon", "sleep"]),
  p("children-crayon", "Crayon box", "children", "#fff7ea", "#222222", "#e03a3a", ["crayon", "school", "learning"]),
  // Teen
  p("teen-electric", "Electric", "teen", "#1a1033", "#f6f0ff", "#00e0c6", ["electric", "academy"]),
  p("teen-sunset", "Sunset drive", "teen", "#ff8a5b", "#2a1220", "#5a1846", ["sunset", "summer"]),
  p("teen-mint", "Mint", "teen", "#d8f5e8", "#16302a", "#d6336c", ["mint", "contemporary"]),
  // Nonfiction
  p("nonfiction-clean", "Clean white", "nonfiction", "#f7f7f5", "#1c1c1c", "#2563eb", ["clean", "white", "modern"]),
  p("nonfiction-slate", "Slate", "nonfiction", "#263238", "#f1f4f5", "#4fc3f7", ["slate", "science", "tech"]),
  p("nonfiction-academic", "Academic", "nonfiction", "#1e3a5f", "#f4f7fb", "#f2b134", ["academic", "textbook", "study"]),
  p("nonfiction-orange", "Field guide", "nonfiction", "#f2efe6", "#1f1f1f", "#d9541e", ["field guide", "orange", "manual"]),
  // Business
  p("business-executive", "Executive", "business", "#0f1c2e", "#f2f5f9", "#3fa9f5", ["executive", "corporate", "leadership"]),
  p("business-money", "Money green", "business", "#0f2e22", "#eef7f2", "#5dd39e", ["money", "wealth", "investing", "finance"]),
  p("business-gold", "Black and gold", "business", "#111111", "#f5f0e1", "#d4af37", ["luxury", "premium", "gold"]),
  p("business-startup", "Startup", "business", "#ffffff", "#111827", "#ff5a1f", ["startup", "marketing", "growth"]),
  // Self-help
  p("selfhelp-sunrise", "Sunrise", "selfhelp", "#fff1e0", "#2b1d12", "#e8590c", ["sunrise", "new start", "motivation"]),
  p("selfhelp-calm", "Calm blue", "selfhelp", "#e3eef7", "#14263a", "#2f6fb0", ["calm", "relationships"]),
  p("selfhelp-bold", "Bold statement", "selfhelp", "#f9d71c", "#111111", "#111111", ["bold", "loud", "statement"]),
  // Wellness
  p("wellness-spa", "Spa", "wellness", "#e6f2ee", "#17332b", "#3f8f7a", ["spa", "calm", "mindfulness"]),
  p("wellness-clay", "Clay", "wellness", "#f1e4d8", "#33231a", "#b5653b", ["clay", "earth", "yoga"]),
  p("wellness-fresh", "Fresh green", "wellness", "#f2f8e9", "#1e2e14", "#5a9a1f", ["fresh", "nutrition", "diet", "plant-based"]),
  // Cookbook
  p("cookbook-tomato", "Tomato", "cookbook", "#fff4ea", "#2a1a12", "#d6342b", ["tomato", "italian", "pasta"]),
  p("cookbook-butter", "Butter and crust", "cookbook", "#fbecc6", "#3a2512", "#a8541e", ["baking", "bread", "butter", "pastry"]),
  p("cookbook-herb", "Herb garden", "cookbook", "#eef3e2", "#1f2a14", "#4f7a28", ["herb", "vegan", "vegetarian", "salad"]),
  p("cookbook-spice", "Spice market", "cookbook", "#3a1a0e", "#fbeee0", "#f0a030", ["spice", "curry", "bbq", "grill"]),
  // Nature
  p("nature-moss", "Moss", "nature", "#24331f", "#eff3ea", "#b7cf6a", ["moss", "forest", "woods"]),
  p("nature-ocean", "Ocean", "nature", "#0d3b4f", "#eaf6f9", "#7fd3e6", ["ocean", "sea", "whale", "coast"]),
  p("nature-desert", "Desert", "nature", "#f2dcc0", "#3a2414", "#b5502a", ["desert", "sand", "canyon"]),
  p("nature-meadow", "Wildflower", "nature", "#f5f2e3", "#2a2a1a", "#7a4fa3", ["wildflower", "flowers", "garden", "bees"]),
  // Travel
  p("travel-passport", "Passport", "travel", "#1f3a5f", "#f5f2ea", "#e8b04a", ["passport", "world"]),
  p("travel-tropics", "Tropics", "travel", "#e8f7f2", "#123a33", "#d9482a", ["tropical", "beach", "island"]),
  p("travel-alpine", "Alpine", "travel", "#eef3f7", "#1a2633", "#c8402f", ["alpine", "mountain", "ski", "hiking"]),
  // Faith
  p("faith-dawn", "Dawn", "faith", "#fbf3e4", "#2a2218", "#b07a2a", ["dawn", "light", "hope"]),
  p("faith-chapel", "Chapel", "faith", "#22304a", "#f6f1e6", "#d8b56a", ["chapel", "prayer", "devotional"]),
  p("faith-olive", "Olive branch", "faith", "#eef0e2", "#24281a", "#6b7a2a", ["olive", "peace"]),
  // Poetry
  p("poetry-ink", "Ink wash", "poetry", "#f4f1ec", "#151515", "#8a2be2", ["ink", "art"]),
  p("poetry-rose", "Pressed rose", "poetry", "#2e1a22", "#f8ecef", "#e8a0b4", ["rose", "love poems"]),
  p("poetry-indigo", "Indigo", "poetry", "#1c2340", "#eef0fa", "#9fb0ff", ["indigo", "night", "moon"]),
  // Seasonal
  p("seasonal-christmas", "Christmas", "seasonal", "#14402b", "#fbf5ea", "#e0b43a", ["christmas", "xmas", "holly"]),
  p("seasonal-candy", "Candy cane", "seasonal", "#fbf6f0", "#2a1414", "#c81d25", ["candy cane", "santa", "red"]),
  p("seasonal-halloween", "Halloween", "seasonal", "#1a1022", "#f7efe6", "#ff7a1a", ["halloween", "pumpkin", "witch"]),
  p("seasonal-autumn", "Autumn", "seasonal", "#3a1f10", "#fbeee0", "#e88a2e", ["autumn", "fall", "harvest", "thanksgiving"]),
  p("seasonal-spring", "Spring", "seasonal", "#eef8e8", "#1e3020", "#d9488b", ["spring", "easter", "blossom"]),
  p("seasonal-winter", "Winter", "seasonal", "#e8f0f7", "#152435", "#3d7bbf", ["winter", "snow", "frost"]),
  p("seasonal-valentine", "Valentine", "seasonal", "#ffe5ea", "#3a0f1c", "#d1144a", ["valentine", "valentines"]),
  // Vintage
  p("vintage-pulp", "Pulp", "vintage", "#f2d43d", "#1a1a1a", "#c0272d", ["pulp", "comic"]),
  p("vintage-diner", "Diner", "vintage", "#e8f4f0", "#1a2a2a", "#d94f4f", ["diner", "1950s", "retro"]),
  p("vintage-seventies", "Seventies", "vintage", "#f3e3c3", "#2e1c0e", "#c4561d", ["1970s", "groovy", "disco"]),
  p("vintage-western", "Western", "vintage", "#3a2414", "#f6e9d6", "#e0a050", ["western", "cowboy", "frontier"]),
  // Bold
  p("bold-cobalt", "Cobalt pop", "bold", "#1238c9", "#ffffff", "#ffd60a", ["cobalt", "pop"]),
  p("bold-tangerine", "Tangerine", "bold", "#ff7a00", "#1a0e00", "#1a0e00", ["orange", "energy"]),
  p("bold-magenta", "Magenta", "bold", "#c2185b", "#fff3f8", "#ffe066", ["magenta", "party"]),
  p("bold-lime", "Lime", "bold", "#c6f432", "#141a05", "#3a1aa8", ["lime", "puzzle", "games"]),
  p("bold-black", "Black and yellow", "bold", "#111111", "#ffffff", "#ffe000", ["warning", "loud"]),
  // Pastel
  p("pastel-peach", "Peach", "pastel", "#ffe5d4", "#3a2418", "#c25a2e", ["peach"]),
  p("pastel-lavender", "Lavender", "pastel", "#ece6fa", "#2a2340", "#6a4fb3", ["lavender", "dreamy"]),
  p("pastel-mint", "Mint cream", "pastel", "#e2f7ee", "#173027", "#2e8a66", ["mint", "baby"]),
  p("pastel-sky", "Powder blue", "pastel", "#e3f0fb", "#172838", "#3a72b0", ["powder", "baby boy"]),
  p("pastel-butter", "Buttercup", "pastel", "#fff6cc", "#2e2a10", "#a87a00", ["buttercup", "coloring"]),
  // Mono
  p("mono-black", "Black", "mono", "#0d0d0d", "#f5f5f5", "#bdbdbd", ["black", "minimal"]),
  p("mono-white", "White", "mono", "#fafafa", "#111111", "#555555", ["white", "minimal", "essay"]),
  p("mono-graphite", "Graphite", "mono", "#3a3d42", "#f2f3f4", "#c9ccd1", ["graphite", "grey", "gray"]),
  p("mono-red", "Black and red", "mono", "#101010", "#f4f4f4", "#e02424", ["red", "stark"]),
];

const BY_ID = new Map(PALETTES.map((x) => [x.id, x]));
export const paletteById = (id: string): NamedPalette | undefined => BY_ID.get(id);

/** The original five, which books without a choice still print with. */
const LEGACY = PALETTES.slice(0, 5);

/** A palette chosen from the title, so a book keeps its colours between prints. */
export function titlePalette(title: string): NamedPalette {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LEGACY[h % LEGACY.length];
}

// --- Colour maths ------------------------------------------------------------------------

const HEX6 = /^#[0-9a-f]{6}$/;

/** "#ABC", "abc", "#aabbcc" → "#aabbcc"; anything else → null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${[...s.slice(1)].map((c) => c + c).join("")}`;
  return HEX6.test(s) ? s : null;
}

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const hexOf = ([r, g, b]: Rgb) => `#${[r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("")}`;

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgbOf(a), rgbOf(b)];
  return hexOf([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
};

function hsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Body text needs 4.5:1; the accent (headings, rules, the spine) 3:1. */
export const TEXT_CONTRAST = 4.5;
export const ACCENT_CONTRAST = 3;

/** Nudges a colour lighter or darker, away from the background, until it reaches the ratio. */
function pushAway(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color;
  const toward = luminance(bg) > 0.4 ? "#000000" : "#ffffff";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(color, toward, t);
    if (contrast(c, bg) >= ratio) return c;
  }
  return toward;
}

/** Makes the text and accent readable on the background. Returns the fixed colours and what changed. */
export function ensureReadable<T extends Palette>(c: T): { colors: T; notes: string[] } {
  const notes: string[] = [];
  let { fg, accent } = c;
  if (contrast(fg, c.bg) < TEXT_CONTRAST) {
    const before = fg;
    fg = pushAway(fg, c.bg, TEXT_CONTRAST);
    notes.push(`The text colour ${before} was hard to read on ${c.bg} (${contrast(before, c.bg).toFixed(1)}:1), so it was changed to ${fg}.`);
  }
  if (contrast(accent, c.bg) < ACCENT_CONTRAST) {
    const before = accent;
    accent = pushAway(accent, c.bg, ACCENT_CONTRAST);
    notes.push(`The accent ${before} barely showed on ${c.bg}, so it was changed to ${accent}.`);
  }
  return { colors: { ...c, fg, accent }, notes };
}

/** The colour that reads best on a background: near-black or near-white. */
export const inkOn = (bg: string) => (contrast("#111111", bg) >= contrast("#fafafa", bg) ? "#111111" : "#fafafa");

// --- Choosing ------------------------------------------------------------------------------

export interface BookLike {
  title: string;
  kind: string;
  genre?: string;
  brief?: string;
  audience?: string;
  subtitle?: string;
}

const KIND_GROUPS: Record<string, Partial<Record<PaletteGroup, number>>> = {
  picture: { children: 4, pastel: 1.5, bold: 1 },
  puzzle: { bold: 2.5, pastel: 1, children: 0.5 },
  ebook: { nonfiction: 1.5, business: 1, selfhelp: 1, wellness: 0.5 },
  novel: { classic: 0.5, literary: 0.5 },
};

const hashOf = (s: string) => {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
};

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9'\- ]+/g, " ").replace(/\s+/g, " ")} `;
const has = (text: string, tag: string) => text.includes(` ${tag} `) || (tag.length > 3 && text.includes(` ${tag}s `));

/** Palettes ranked for a book from its kind, genre, brief, audience and title. Best first. */
export function rankPalettes(book: BookLike): { palette: NamedPalette; score: number }[] {
  const genre = words(book.genre ?? "");
  const rest = words(`${book.title} ${book.subtitle ?? ""} ${book.brief ?? ""} ${book.audience ?? ""}`);
  const kindBoost = KIND_GROUPS[book.kind] ?? {};
  const groupScore = new Map<PaletteGroup, number>();
  for (const g of PALETTE_GROUPS) {
    let s = kindBoost[g] ?? 0;
    for (const t of GROUP_TAGS[g]) {
      if (has(genre, t)) s += 3;
      if (has(rest, t)) s += 1;
    }
    groupScore.set(g, s);
  }
  const seed = hashOf(book.title || book.brief || "");
  return PALETTES.map((pal, i) => {
    let s = groupScore.get(pal.group) ?? 0;
    for (const t of pal.tags) {
      if (has(genre, t)) s += 2;
      if (has(rest, t)) s += 1;
    }
    // A small, stable tie-break so books in the same genre don't all get the same palette
    const jitter = ((seed + i * 2654435761) >>> 0) % 1000 / 10000;
    return { palette: pal, score: s + jitter };
  }).sort((a, b) => b.score - a.score);
}

/** The best palette for a book, or the title's palette when nothing about the book points anywhere. */
export function autoPalette(book: BookLike): NamedPalette {
  const [top] = rankPalettes(book);
  return top && top.score >= 1 ? top.palette : titlePalette(book.title);
}

/** Up to n suggestions for the book, best first. */
export function suggestPalettes(book: BookLike, n = 8): NamedPalette[] {
  const ranked = rankPalettes(book).filter((r) => r.score >= 1).map((r) => r.palette);
  const out = ranked.slice(0, n);
  if (out.length < n) for (const pal of [titlePalette(book.title), ...PALETTES]) if (out.length < n && !out.includes(pal)) out.push(pal);
  return out;
}

/** The colours a cover prints with: the book's own, or the original title palette. */
export function colorsFor(book: { title: string; coverColors?: CoverColors }): Palette & { band: BandStyle } {
  const c = book.coverColors;
  if (c) return { ...ensureReadable({ bg: c.bg, fg: c.fg, accent: c.accent }).colors, band: c.band ?? "palette" };
  const t = titlePalette(book.title);
  return { bg: t.bg, fg: t.fg, accent: t.accent, band: "dark" };
}

/**
 * Reads cover colours sent by the Books page, an agent or the API. Takes a preset id
 * ("mystery-noir"), "auto", { bg, fg, accent } (or background/text), or a list
 * [background, accent, text] like Jarvis's book studio. Returns the colours, null to
 * clear them, or what's wrong.
 */
export function parseCoverColors(input: unknown, book: BookLike, brand?: { background: string; text: string; accent: string }): CoverColors | null | { error: string } {
  if (input === null || input === "" || (Array.isArray(input) && !input.length)) return null;
  if (typeof input === "string") {
    const id = input.trim();
    if (id === "auto") return { ...pick(autoPalette(book)), source: "auto" };
    if (id === "brand") {
      if (!brand) return { error: "There's no brand kit to take colours from" };
      return { ...ensureReadable({ bg: brand.background, fg: brand.text, accent: brand.accent }).colors, source: "brand" };
    }
    const pal = paletteById(id);
    if (pal) return { ...pick(pal), source: "preset", palette: pal.id };
    const list = id.split(/[\s,;]+/).filter(Boolean);
    if (list.length === 3) return parseCoverColors(list, book, brand);
    return { error: `Unknown palette “${id.slice(0, 40)}”` };
  }
  if (Array.isArray(input)) {
    if (input.length !== 3) return { error: `Cover colours need 3 colours [background, accent, text]; got ${input.length}` };
    const [bg, accent, fg] = input.map(normalizeHex);
    const bad = input.find((x, i) => ![bg, accent, fg][i]);
    if (bad !== undefined) return { error: `“${String(bad).slice(0, 30)}” isn't a hex colour like #1f2a44` };
    return { bg: bg!, fg: fg!, accent: accent!, source: "custom" };
  }
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.palette === "string" && !("bg" in o || "background" in o)) {
      const base = parseCoverColors(o.palette, book, brand);
      if (!base || "error" in base) return base;
      return withOptions(base, o);
    }
    const raw = { bg: o.bg ?? o.background, fg: o.fg ?? o.text, accent: o.accent };
    const bg = normalizeHex(raw.bg);
    const fg = normalizeHex(raw.fg);
    const accent = normalizeHex(raw.accent);
    for (const [k, v, n] of [["background", raw.bg, bg], ["text", raw.fg, fg], ["accent", raw.accent, accent]] as const) {
      if (!n) return { error: v === undefined ? `Cover colours need a ${k} colour` : `The ${k} colour “${String(v).slice(0, 30)}” isn't a hex colour like #1f2a44` };
    }
    const source: ColorSource = typeof o.source === "string" && ["picture", "brand", "writer", "auto"].includes(o.source) ? (o.source as ColorSource) : "custom";
    const pal = typeof o.palette === "string" ? paletteById(o.palette) : undefined;
    return withOptions({ bg: bg!, fg: fg!, accent: accent!, source, ...(pal ? { palette: pal.id } : {}) }, o);
  }
  return { error: "Cover colours: send a palette name, { bg, fg, accent } or [background, accent, text]" };
}

const pick = (x: Palette): Palette => ({ bg: x.bg, fg: x.fg, accent: x.accent });

function withOptions(c: CoverColors, o: Record<string, unknown>): CoverColors {
  const out = { ...c };
  if (typeof o.locked === "boolean") out.locked = o.locked;
  if (typeof o.band === "string" && (BAND_STYLES as string[]).includes(o.band)) out.band = o.band as BandStyle;
  return out;
}

/** Automation may change these colours: they were picked for the book, not by you. */
export const automatic = (c: CoverColors | undefined) => !c || (!c.locked && (c.source === "auto" || c.source === "writer" || c.source === "picture"));

// --- From a picture ------------------------------------------------------------------------

/**
 * Colours from a picture's pixels (RGB triples, row by row, `width` wide). The background
 * is the picture's main colour, weighted toward its left edge (which meets the spine); the
 * accent is its most vivid colour that stands apart from the background; the text is a
 * tinted off-white or off-black, whichever reads.
 */
export function paletteFromPixels(pixels: Rgb[], width: number): Palette {
  if (!pixels.length) throw new Error("The picture had no pixels");
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  pixels.forEach(([r, g, b], i) => {
    const x = i % width;
    const w = x < width / 6 ? 3 : 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n += w;
    bin.r += r * w;
    bin.g += g * w;
    bin.b += b * w;
    bins.set(key, bin);
  });
  const colours = [...bins.values()].map((x) => ({ n: x.n, hex: hexOf([x.r / x.n, x.g / x.n, x.b / x.n]) })).sort((a, b) => b.n - a.n);
  // Merge near neighbours into the main colour so a gradient counts as one colour
  const main = colours[0].hex;
  let bg = main;
  const [, s, l] = hsl(bg);
  // A muddy mid-tone makes a poor background: deepen it a little, keeping the hue
  if (l > 0.35 && l < 0.65 && s < 0.35) bg = mix(bg, "#000000", 0.45);
  const total = colours.reduce((n, c) => n + c.n, 0);
  let accent = "";
  let best = -1;
  for (const c of colours) {
    if (c.n < total * 0.004) continue;
    const [h, sat, lig] = hsl(c.hex);
    const [bh] = hsl(bg);
    const hueGap = Math.min(Math.abs(h - bh), 360 - Math.abs(h - bh)) / 180;
    const score = sat * 1.2 + hueGap * 0.6 + Math.min(contrast(c.hex, bg), 7) / 7 + Math.min(c.n / total, 0.2) * 2 - Math.abs(lig - 0.55) * 0.5;
    if (score > best) {
      best = score;
      accent = c.hex;
    }
  }
  if (!accent) accent = luminance(bg) > 0.4 ? mix(bg, "#000000", 0.6) : mix(bg, "#ffffff", 0.6);
  const ink = inkOn(bg);
  const fg = mix(ink, main, 0.08);
  return ensureReadable({ bg, fg, accent }).colors;
}

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what Chrome screenshots are) into RGB pixels. */
export function decodePng(buf: Buffer): { width: number; height: number; pixels: Rgb[] } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("Not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let type = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      type = data[9];
      if (depth !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) throw new Error("Only 8-bit RGB/RGBA PNGs are read");
    } else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  const pixels: Rgb[] = [];
  for (let i = 0; i < width * height; i++) {
    const alpha = bpp === 4 ? out[i * 4 + 3] / 255 : 1;
    // Transparent areas count as white, as they print
    pixels.push([0, 1, 2].map((k) => out[i * bpp + k] * alpha + 255 * (1 - alpha)) as Rgb);
  }
  return { width, height, pixels };
}

// --- For the Books page and the Writer ------------------------------------------------------

/** The library as the Books page shows it, grouped. */
export function paletteLibrary() {
  return PALETTE_GROUPS.map((g) => ({ group: g, label: GROUP_LABEL[g], palettes: PALETTES.filter((x) => x.group === g).map(({ tags, ...rest }) => rest) }));
}

/** A short menu of palette ids for the Writer to choose from when it writes the listing. */
export function paletteMenu(book: BookLike, n = 16): string {
  return suggestPalettes(book, n)
    .map((x) => `${x.id} (${x.name}: ${x.bg} background, ${x.accent} accent)`)
    .join("; ");
}
