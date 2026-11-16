import type { TaskStore } from "./taskstore";

// Things you should know about that didn't stop the work: a budget was hit, a
// local-only agent was kept off the cloud, a price is missing. Shown as a banner
// on the dashboard until dismissed. Repeats of the same notice are counted, not duplicated.

export interface Notice {
  id: string;
  key: string;
  kind: "budget" | "local-only" | "price-missing" | "fallback" | "read-only" | "routine" | "skill";
  message: string;
  firstAt: number;
  lastAt: number;
  count: number;
  dismissed?: boolean;
}

const MAX = 50;

export class Notices {
  private store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
  }

  list(includeDismissed = false): Notice[] {
    const all = this.store.getSetting<Notice[]>("notices", []);
    return (includeDismissed ? all : all.filter((n) => !n.dismissed)).sort((a, b) => b.lastAt - a.lastAt);
  }

  add(kind: Notice["kind"], key: string, message: string): Notice {
    const all = this.store.getSetting<Notice[]>("notices", []);
    const now = Date.now();
    let n = all.find((x) => x.key === key && !x.dismissed);
    if (n) {
      n.count++;
      n.lastAt = now;
      n.message = message;
    } else {
      n = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, key, kind, message, firstAt: now, lastAt: now, count: 1 };
      all.push(n);
    }
    this.store.setSetting("notices", all.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX));
    return n;
  }

  dismiss(id?: string) {
    const all = this.store.getSetting<Notice[]>("notices", []);
    for (const n of all) if (!id || n.id === id) n.dismissed = true;
    this.store.setSetting("notices", all);
  }
}
