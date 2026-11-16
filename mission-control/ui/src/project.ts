import { useEffect, useSyncExternalStore } from "react";
import { getJson } from "./api";

// The project the dashboard is looking at: "all", "general" (cards outside any
// project) or a project id. Remembered in this browser.

export interface ProjectInfo {
  id: string;
  name: string;
  color: string;
  instructions: string;
  localOnly: boolean;
  archived: boolean;
  workspace?: string | null;
  profiles: string[];
  ownBrand: boolean;
  counts: { cards: number; open: number; memories: number; skills: number; assets: number; routines: number };
}

export type ProjectView = "all" | "general" | string;

const KEY = "mc.project";
let current: ProjectView = (() => {
  try {
    return localStorage.getItem(KEY) || "all";
  } catch {
    return "all";
  }
})();
let list: ProjectInfo[] = [];
let snapshot = { current, list };
const listeners = new Set<() => void>();
const notify = () => {
  snapshot = { current, list };
  listeners.forEach((l) => l());
};

export function setProject(p: ProjectView) {
  current = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* private mode */
  }
  notify();
}

let loading: Promise<void> | null = null;
export function reloadProjects(): Promise<void> {
  loading = getJson<{ projects: ProjectInfo[] }>("/api/projects")
    .then((r) => {
      list = r.projects;
      // A project that's gone or archived: back to everything
      if (current !== "all" && current !== "general" && !list.some((p) => p.id === current && !p.archived)) current = "all";
      notify();
    })
    .catch(() => {})
    .finally(() => (loading = null));
  return loading;
}

/** The current view, the projects, and helpers. */
export function useProjects() {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
  useEffect(() => {
    if (!list.length && !loading) void reloadProjects();
  }, []);
  const active = s.list.filter((p) => !p.archived);
  return {
    view: s.current,
    projects: s.list,
    active,
    /** The project id new things go in: null for General (also when looking at everything) */
    target: s.current === "all" || s.current === "general" ? null : s.current,
    byId: (id: string | null | undefined) => (id ? s.list.find((p) => p.id === id) : undefined),
    /** ?project=… for the API */
    query: s.current === "all" ? "" : `project=${encodeURIComponent(s.current)}`,
  };
}

/** Whether a card (or anything with a project) shows in this view. */
export const inView = (project: string | null | undefined, view: ProjectView) => view === "all" || (view === "general" ? !project : project === view);
