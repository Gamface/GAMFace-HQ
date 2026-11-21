// The Gallery: every picture and video clip HQ made (tool pictures, rendered videos),
// with the card it came from and whether it's in the asset dictionary yet.

export type GalleryKind = "image" | "video";

export interface GalleryItem {
  name: string;
  kind: GalleryKind;
  bytes: number;
  at: number;
  /** The card that made it; missing when the card is gone */
  card?: { id: string; title: string; project?: string | null };
  /** The asset it was added as, if any */
  asset?: string;
  /** A starting name for the asset, from the file name */
  suggestedName: string;
}

export function galleryKind(name: string): GalleryKind | null {
  if (/\.(png|jpg|webp)$/i.test(name)) return "image";
  if (/\.mp4$/i.test(name)) return "video";
  return null;
}

/** "images-a-red-fox-in-the-snow-1a2b3c4d.png" → "A red fox in the snow" */
export function suggestedName(file: string): string {
  const words = file
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/-[a-f0-9]{8}$/, "")
    .replace(/^(images|inspo)(-(recommend|search-screens|get-screen))?(-|$)/, "")
    .replace(/-/g, " ")
    .trim();
  const name = (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 60).trim();
  return name || "Picture";
}

interface CardLike {
  id: string;
  title?: string;
  prompt: string;
  project?: string | null;
  parentId?: string;
  files?: { name: string }[];
}

/**
 * The gallery for a view: undefined = everything, null = General (cards without a
 * project, and files whose card is gone), or a project id.
 */
export function galleryItems(
  files: { name: string; bytes: number; at: number }[],
  cards: Iterable<CardLike>,
  assets: { id: string; source?: string }[],
  view: string | null | undefined,
): GalleryItem[] {
  const owner = new Map<string, CardLike>();
  for (const c of cards) if (!c.parentId) for (const f of c.files ?? []) owner.set(f.name, c);
  const added = new Map(assets.filter((a) => a.source).map((a) => [a.source!, a.id]));
  const out: GalleryItem[] = [];
  for (const f of files) {
    const kind = galleryKind(f.name);
    if (!kind) continue;
    const c = owner.get(f.name);
    const project = c?.project ?? null;
    if (view !== undefined && project !== view) continue;
    out.push({
      ...f,
      kind,
      ...(c ? { card: { id: c.id, title: (c.title || c.prompt).slice(0, 120), project } } : {}),
      ...(added.has(f.name) ? { asset: added.get(f.name) } : {}),
      suggestedName: suggestedName(f.name),
    });
  }
  return out;
}
