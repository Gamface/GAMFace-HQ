import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";

// Tiny JSON-file persistence for the hive log and memories. Writes go to a temp
// file first, so a crash mid-write never corrupts the store.
export class JsonStore<T> {
  private file: string;
  data: T;

  constructor(dir: string, name: string, fallback: T) {
    this.file = path.join(dir, name);
    if (dir !== ":memory:") mkdirSync(dir, { recursive: true });
    this.data = fallback;
    if (dir === ":memory:") return;
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as T;
    } catch {
      // first run, or an unreadable file: start from the fallback
    }
  }

  save() {
    if (this.file.startsWith(":memory:")) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    renameSync(tmp, this.file);
  }
}
