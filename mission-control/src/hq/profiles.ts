// Browser profiles (Phase 5). Each profile is a separate set of logins: its cookies
// are loaded into a fresh, isolated browser context when a run starts and saved
// back when it ends, so a sign-in survives restarts of Chrome and Mission Control.
// Read-only runs never use a profile (they always get a throwaway one).
//
// Cookies are sign-ins, so the files are written readable by you only, and are
// encrypted (AES-256-GCM) when PROFILE_SECRET is set.

import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_PROFILES = 20;

/** A cookie as Chrome's Storage.getCookies returns it (only the fields setCookies needs). */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  session?: boolean;
}

export interface ProfileInfo {
  name: string;
  cookies: number;
  sites: string[];
  savedAt?: number;
  encrypted: boolean;
}

interface Envelope {
  v: 1;
  enc?: { iv: string; tag: string; data: string };
  cookies?: StoredCookie[];
  savedAt: number;
}

export class Profiles {
  private key: Buffer | null;

  constructor(
    private dir: string,
    secret = process.env.PROFILE_SECRET ?? "",
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.key = secret ? crypto.createHash("sha256").update(`mission-control-profiles:${secret}`).digest() : null;
  }

  private file(name: string) {
    return path.join(this.dir, `${name}.json`);
  }

  private read(name: string): Envelope | null {
    if (!PROFILE_NAME.test(name) || !existsSync(this.file(name))) return null;
    try {
      return JSON.parse(readFileSync(this.file(name), "utf8")) as Envelope;
    } catch {
      return null;
    }
  }

  exists(name: string): boolean {
    return PROFILE_NAME.test(name) && existsSync(this.file(name));
  }

  list(): ProfileInfo[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json") && PROFILE_NAME.test(f.slice(0, -5)))
      .map((f) => this.info(f.slice(0, -5)))
      .filter((p): p is ProfileInfo => Boolean(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  info(name: string): ProfileInfo | null {
    const env = this.read(name);
    if (!env) return null;
    let cookies: StoredCookie[] = [];
    try {
      cookies = this.cookies(name);
    } catch {
      // encrypted with another key
    }
    const sites = [...new Set(cookies.map((c) => c.domain.replace(/^\./, "").replace(/^www\./, "")))].sort().slice(0, 30);
    return { name, cookies: cookies.length, sites, savedAt: env.savedAt || undefined, encrypted: Boolean(env.enc) };
  }

  /** Creates an empty profile. Returns an error message when it can't. */
  create(name: string): string | null {
    if (!PROFILE_NAME.test(name)) return "Profile names are lowercase letters, numbers and dashes (up to 32)";
    if (this.exists(name)) return `A profile called “${name}” already exists`;
    if (this.list().length >= MAX_PROFILES) return `At most ${MAX_PROFILES} profiles`;
    this.save(name, []);
    return null;
  }

  remove(name: string): boolean {
    if (!this.exists(name)) return false;
    rmSync(this.file(name));
    return true;
  }

  /** The profile's saved cookies (empty when it has none). Throws when the file can't be decrypted. */
  cookies(name: string): StoredCookie[] {
    const env = this.read(name);
    if (!env) return [];
    if (!env.enc) return env.cookies ?? [];
    if (!this.key) throw new Error(`Profile “${name}” is encrypted: set the same PROFILE_SECRET to use it`);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(env.enc.iv, "base64"));
    decipher.setAuthTag(Buffer.from(env.enc.tag, "base64"));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(env.enc.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as StoredCookie[];
    } catch {
      throw new Error(`Profile “${name}” can't be decrypted: PROFILE_SECRET has changed`);
    }
  }

  /** Saves cookies, dropping ones that have already expired. */
  save(name: string, cookies: StoredCookie[]) {
    if (!PROFILE_NAME.test(name)) throw new Error("bad profile name");
    const now = Date.now() / 1000;
    const keep = cookies
      .filter((c) => c.session || !c.expires || c.expires < 0 || c.expires > now)
      .map(({ name, value, domain, path, expires, httpOnly, secure, sameSite, session }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite, session }));
    let env: Envelope = { v: 1, cookies: keep, savedAt: Date.now() };
    if (this.key) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(keep), "utf8"), cipher.final()]);
      env = { v: 1, enc: { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }, savedAt: Date.now() };
    }
    const tmp = `${this.file(name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
    renameSync(tmp, this.file(name));
    try {
      chmodSync(this.file(name), 0o600);
    } catch {
      // Windows file systems ignore modes
    }
  }

  /** Bytes on disk, for the page. */
  size(name: string): number {
    return this.exists(name) ? statSync(this.file(name)).size : 0;
  }
}

/** Cookies in the shape Storage.setCookies accepts. */
export function toCdpCookies(cookies: StoredCookie[]) {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.session || !c.expires || c.expires < 0 ? {} : { expires: c.expires }),
  }));
}
