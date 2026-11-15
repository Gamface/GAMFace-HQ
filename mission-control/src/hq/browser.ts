import { lookup } from "dns/promises";
import { isSensitiveField } from "./approvals";
import type { ActionRequest } from "./approvals";
import { isIP } from "net";

// A real Chrome the browser agent can drive, with a live screencast for the
// dashboard. Talks the Chrome DevTools Protocol directly over Node's built-in
// WebSocket, so it needs no npm packages. Chrome runs in its own container
// (chromedp/headless-shell, see docker-compose.yml).
//
// Safety: every request the page makes (navigations, redirects, images, XHR)
// is checked, and anything aimed at localhost or your private network is
// blocked, so a web page can't steer the agent into your router, the harness
// or other services on your LAN.

type Listener = (method: string, params: any, sessionId?: string) => void;

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
      }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("browser connection closed"));
      this.pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error(`could not connect to Chrome at ${url}`)), 10000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`could not connect to Chrome at ${url}`));
      };
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("browser connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

// --- URL safety ---------------------------------------------------------------
function isPrivateAddress(ip: string): boolean {
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

const hostVerdicts = new Map<string, boolean>();

/** Returns a reason string when the URL must not be loaded, or null when it is fine. */
export async function blockedReason(rawUrl: string, allowPrivate = false): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "not a valid URL";
  }
  if (["data:", "blob:", "about:"].includes(url.protocol)) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol} URLs are not allowed`;
  if (allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "local addresses are blocked";
  }
  if (!hostVerdicts.has(host)) {
    let blocked = false;
    try {
      const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
      blocked = addrs.some((a) => isPrivateAddress(a.address));
    } catch {
      blocked = false; // unresolvable: let Chrome report the error
    }
    hostVerdicts.set(host, blocked);
  }
  return hostVerdicts.get(host) ? "private network addresses are blocked" : null;
}

/** Finds Chrome's WebSocket URL. Chrome only answers /json requests addressed by IP. */
export async function resolveCdpUrl(base: string): Promise<string> {
  if (base.startsWith("ws://") || base.startsWith("wss://")) return base;
  const u = new URL(base);
  const ip = isIP(u.hostname) ? u.hostname : (await lookup(u.hostname)).address;
  const hostPort = `${ip.includes(":") ? `[${ip}]` : ip}:${u.port || "9222"}`;
  const res = await fetch(`${u.protocol}//${hostPort}/json/version`, { signal: AbortSignal.timeout(5000) });
  const info = (await res.json()) as { webSocketDebuggerUrl: string };
  const ws = new URL(info.webSocketDebuggerUrl);
  return `ws://${hostPort}${ws.pathname}`;
}

// --- Session ------------------------------------------------------------------
export interface PageState {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  fields: string[];
  // Large pictures on the page, so reports can use real image URLs
  images?: { alt: string; src: string }[];
}

export interface Frame {
  data: string; // base64 JPEG
  url: string;
  title: string;
}

const VIEWPORT = { width: 1280, height: 800 };

// Runs in the page: finds the best element for a description like "Sign in" or "search box".
const FIND_ELEMENT = `(kind, wanted) => {
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const w = norm(wanted);
  const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none"; };
  const label = (el) => norm([el.innerText, el.value, el.getAttribute("aria-label"), el.getAttribute("title"), el.getAttribute("placeholder"), el.getAttribute("name"), el.id && document.querySelector('label[for="' + el.id + '"]')?.innerText, el.alt].filter(Boolean).join(" "));
  const sel = kind === "field" ? 'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, [contenteditable="true"], select'
            : kind === "link" ? 'a[href]'
                               : 'a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=submit], input[type=button], summary, label';
  const els = [...document.querySelectorAll(sel)].filter(visible);
  let best = null, score = 0;
  for (const el of els) {
    const l = label(el);
    let s = !w ? 1 : l === w ? 100 : l.startsWith(w) ? 60 : l.includes(w) ? 40 : w.split(" ").filter((x) => x && l.includes(x)).length * 5;
    if (s > score) { score = s; best = el; }
  }
  if (!best && kind === "field") best = els[0] || null;
  if (!best) return null;
  best.scrollIntoView({ block: "center" });
  window.__mcTarget = best;
  return label(best).slice(0, 80) || best.tagName.toLowerCase();
}`;

// What kind of thing the current target is: a plain link, a form submit, a search
const TARGET_INFO = `(() => {
  const el = window.__mcTarget;
  const a = el.closest("a[href]");
  const raw = a ? a.getAttribute("href") || "" : "";
  const form = el.form || el.closest("form");
  const t = (el.getAttribute("type") || "").toLowerCase();
  const submits = !!form && ((el.tagName === "BUTTON" && (t === "" || t === "submit")) || (el.tagName === "INPUT" && (t === "submit" || t === "image")));
  const method = form ? (form.getAttribute("method") || "get").toLowerCase() : "";
  const search = !!form && method === "get" && !!form.querySelector('input[type=search], [role=searchbox], input[name=q], input[name=query], input[name=search]');
  return { href: a ? a.href : "", scripted: !a || raw.startsWith("#") || /^javascript:/i.test(raw) || el.hasAttribute("onclick") || a.hasAttribute("onclick"), submits, search };
})()`;

const FIELD_INFO = `(() => {
  const el = window.__mcTarget;
  const form = el.form || el.closest("form");
  const label = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.id && document.querySelector('label[for="' + el.id + '"]')?.innerText, el.closest("label")?.innerText].filter(Boolean).join(" ").slice(0, 200);
  const name = (el.getAttribute("name") || el.id || "").slice(0, 100);
  const type = (el.getAttribute("type") || "").toLowerCase();
  const search = type === "search" || el.getAttribute("role") === "searchbox" || /^(q|query|search|s|keywords?)$/i.test(name) || /\bsearch\b/i.test(label);
  return { type, autocomplete: el.getAttribute("autocomplete") || "", name, label, search, method: form ? (form.getAttribute("method") || "get").toLowerCase() : "get" };
})()`;

const READ_PAGE = `(() => {
  const text = (document.body?.innerText || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 6000);
  const links = [...document.querySelectorAll("a[href]")].filter((a) => a.innerText.trim() && a.getBoundingClientRect().width > 0)
    .slice(0, 40).map((a) => ({ text: a.innerText.replace(/\\s+/g, " ").trim().slice(0, 80), href: a.href }));
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]), textarea, select')]
    .filter((e) => e.getBoundingClientRect().width > 0).slice(0, 15)
    .map((e) => e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("name") || e.type);
  const images = [...document.images].filter((im) => im.naturalWidth >= 200 && im.naturalHeight >= 120 && /^https:/.test(im.currentSrc || im.src))
    .slice(0, 8).map((im) => ({ alt: (im.alt || im.title || "").replace(/\s+/g, " ").trim().slice(0, 80), src: (im.currentSrc || im.src).slice(0, 400) }));
  return { url: location.href, title: document.title, text, links, fields, images };
})()`;

/** Hostname without "www.", lowercased */
function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Search results link through the search engine's redirect page
 * (duckduckgo.com/l/?uddg=<real address>). Returns the real address, or null
 * when the link is not such a redirect.
 */
export function searchResultTarget(href: string): string | null {
  try {
    const u = new URL(href);
    if (!/(^|\.)duckduckgo\.com$/i.test(u.hostname) || u.pathname !== "/l/") return null;
    const dest = u.searchParams.get("uddg");
    return dest && /^https?:\/\//i.test(dest) ? dest : null;
  } catch {
    return null;
  }
}

export interface ReadOnlyOptions {
  /** Sites this run may open, e.g. ["example.com"]; subdomains included */
  allowedSites: string[];
}

/** Asks before an action that changes something; resolves to null to go ahead, or why not. */
export type ActionGate = (req: ActionRequest) => Promise<string | null>;

export class BrowserSession {
  private cdp!: Cdp;
  private gate: ActionGate | null;
  // Sites a run that may act is kept to (routines); empty means anywhere
  private sites: string[];
  private sessionId = "";
  private targetId = "";
  private contextId = "";
  private readOnly: ReadOnlyOptions | null;
  private loadWaiters: (() => void)[] = [];
  private allowPrivate: boolean;
  private onFrame: (f: Frame) => void;
  private onBlocked: (url: string, reason: string) => void;
  private current = { url: "about:blank", title: "" };

  constructor(
    opts: {
      allowPrivate?: boolean;
      readOnly?: ReadOnlyOptions;
      onFrame?: (f: Frame) => void;
      onBlocked?: (url: string, reason: string) => void;
      gate?: ActionGate;
      sites?: string[];
    } = {},
  ) {
    this.allowPrivate = Boolean(opts.allowPrivate);
    this.gate = opts.gate ?? null;
    this.sites = (opts.sites ?? []).map((x) => x.toLowerCase().replace(/^www\./, ""));
    this.readOnly = opts.readOnly ? { allowedSites: opts.readOnly.allowedSites.map((x) => x.toLowerCase().replace(/^www\./, "")) } : null;
    this.onFrame = opts.onFrame ?? (() => {});
    this.onBlocked = opts.onBlocked ?? (() => {});
  }

  async start(cdpBase: string) {
    this.cdp = await Cdp.connect(await resolveCdpUrl(cdpBase));
    // Read-only runs get a throwaway profile: no cookies, so never logged in anywhere
    if (this.readOnly) {
      const { browserContextId } = await this.cdp.send("Target.createBrowserContext", { disposeOnDetach: true });
      this.contextId = browserContextId;
    }
    // The page size is set below (device metrics); newer Chrome refuses a size here
    // ("Target position can only be set for new windows")
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank", ...(this.contextId ? { browserContextId: this.contextId } : {}) });
    this.targetId = targetId;
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    this.cdp.on((method, params, sid) => {
      if (sid !== this.sessionId) return;
      if (method === "Page.loadEventFired") {
        this.loadWaiters.splice(0).forEach((r) => r());
      } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
        this.current.url = params.frame.url;
      } else if (method === "Page.screencastFrame") {
        void this.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.sessionId).catch(() => {});
        this.onFrame({ data: params.data, url: this.current.url, title: this.current.title });
      } else if (method === "Fetch.requestPaused") {
        void this.screenRequest(params.requestId, params.request.url, params.request.method, params.resourceType);
      }
    });
    const s = this.sessionId;
    await this.cdp.send("Page.enable", {}, s);
    await this.cdp.send("Runtime.enable", {}, s);
    await this.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, s);
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, s);
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height }, s);
  }

  private get siteList(): string[] {
    return this.readOnly?.allowedSites ?? this.sites;
  }

  /** Whether a page on this URL may be opened (read-only runs and routines are kept to their sites). */
  siteAllowed(url: string): boolean {
    const list = this.siteList;
    if (!list.length && !this.readOnly) return true;
    if (/^(about|data|blob):/i.test(url)) return true;
    const site = siteOf(url);
    return Boolean(site) && list.some((a) => site === a || site.endsWith(`.${a}`));
  }

  private readOnlyReason(url: string, method: string, resourceType?: string): string | null {
    if (!this.readOnly) return resourceType === "Document" && !this.siteAllowed(url) ? "outside the sites this routine may visit" : null;
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) return `read-only run: ${method} requests (form submits, sending data) are blocked`;
    if (resourceType === "Document" && !this.siteAllowed(url)) return "read-only run: outside the sites this run may visit";
    return null;
  }

  private async screenRequest(requestId: string, url: string, method = "GET", resourceType?: string) {
    const reason = this.readOnlyReason(url, method, resourceType) ?? (await blockedReason(url, this.allowPrivate));
    try {
      if (reason) {
        this.onBlocked(url, reason);
        await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, this.sessionId);
      } else {
        await this.cdp.send("Fetch.continueRequest", { requestId }, this.sessionId);
      }
    } catch {
      // request already gone
    }
  }

  private waitForLoad(timeoutMs = 15000) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.loadWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async evaluate<T>(expression: string): Promise<T> {
    const r = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "script error in page");
    return r.result.value as T;
  }

  private async settle(navigating: boolean) {
    if (navigating) await this.waitForLoad();
    await new Promise((r) => setTimeout(r, 600));
    this.current.title = (await this.evaluate<string>("document.title").catch(() => "")) || "";
  }

  async navigate(url: string): Promise<string> {
    if (!/^[a-z]+:/i.test(url)) url = `https://${url}`;
    const reason =
      (this.siteAllowed(url) ? null : `${this.readOnly ? "read-only run" : "this routine"}: only ${this.siteList.join(", ")} may be opened`) ?? (await blockedReason(url, this.allowPrivate));
    if (reason) throw new Error(`Blocked ${url}: ${reason}`);
    const load = this.waitForLoad();
    const r = await this.cdp.send("Page.navigate", { url }, this.sessionId);
    if (r.errorText) throw new Error(`Could not open ${url}: ${r.errorText}`);
    await load;
    await this.settle(false);
    return `Opened ${this.current.url}`;
  }

  async read(): Promise<PageState> {
    const state = await this.evaluate<PageState>(READ_PAGE);
    // Show where search results really lead, so the agent can tell which ones it may open
    state.links = state.links.map((l) => ({ ...l, href: searchResultTarget(l.href) ?? l.href }));
    this.current = { url: state.url, title: state.title };
    return state;
  }

  async click(target: string): Promise<string> {
    // Read-only runs may only follow links to allowed sites: no buttons, no "confirm" or form controls
    const found = await this.evaluate<string | null>(`(${FIND_ELEMENT})(${JSON.stringify(this.readOnly ? "link" : "click")}, ${JSON.stringify(target)})`);
    if (!found) throw new Error(this.readOnly ? `No link matches "${target}" (read-only runs can only follow links)` : `Nothing clickable matches "${target}"`);
    if (this.readOnly) {
      const raw = await this.evaluate<string>("window.__mcTarget.href || ''");
      // A search result is judged by where it leads, and opened there directly
      const dest = searchResultTarget(raw);
      const href = dest ?? raw;
      if (!/^https?:/i.test(href)) throw new Error(`Blocked link "${found}": read-only runs only follow web links`);
      if (!this.siteAllowed(href)) throw new Error(`Blocked link to ${href}: read-only run, outside ${this.readOnly.allowedSites.join(", ")}`);
      if (dest) {
        await this.navigate(dest);
        return `Followed "${found}" → ${this.current.url}`;
      }
    }
    if (!this.readOnly) {
      // A plain web link is opened like typing its address: no approval needed.
      // Buttons, form submits and script links change things, so they ask first.
      const info = await this.evaluate<{ href: string; scripted: boolean; submits: boolean; search: boolean }>(TARGET_INFO);
      if (info.href && /^https?:/i.test(info.href) && !info.scripted && !info.submits) {
        await this.navigate(searchResultTarget(info.href) ?? info.href);
        return `Followed "${found}" → ${this.current.url}`;
      }
      await this.ask({ kind: info.submits ? (info.search ? "search" : "submit") : "click", target: found });
    }
    const before = this.current.url;
    const load = this.waitForLoad(5000);
    await this.evaluate("window.__mcTarget.click(), true");
    await Promise.race([load, new Promise((r) => setTimeout(r, 1500))]);
    await this.settle(false);
    return `Clicked "${found}"${this.current.url !== before ? ` → ${this.current.url}` : ""}`;
  }

  async type(field: string, text: string, submit: boolean): Promise<string> {
    if (this.readOnly) throw new Error("Typing is disabled in read-only runs");
    const found = await this.evaluate<string | null>(`(${FIND_ELEMENT})("field", ${JSON.stringify(field)})`);
    if (!found) throw new Error(`No text field matches "${field}"`);
    const info = await this.evaluate<{ type: string; autocomplete: string; name: string; label: string; search: boolean; method: string }>(FIELD_INFO);
    if (isSensitiveField(info))
      throw new Error(`"${found}" looks like a password, payment, ID or one-time-code field. Mission Control never types into those: the user must enter it themselves.`);
    const shown = info.label.replace(/\s+/g, " ").trim().slice(0, 80) || found;
    await this.ask({ kind: info.search && info.method !== "post" ? "search" : submit ? "submit" : "type", target: shown, text });
    await this.evaluate("window.__mcTarget.focus(), window.__mcTarget.select?.(), true");
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
    if (submit) {
      const load = this.waitForLoad(8000);
      for (const type of ["rawKeyDown", "char", "keyUp"]) {
        await this.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "char" ? "\r" : undefined }, this.sessionId);
      }
      await Promise.race([load, new Promise((r) => setTimeout(r, 2500))]);
    }
    await this.settle(false);
    return `Typed into "${found}"${submit ? " and pressed Enter" : ""}`;
  }

  /** Asks the gate about an action on the current target; throws when it may not go ahead. */
  private async ask(req: Omit<ActionRequest, "url" | "site" | "screenshot">) {
    if (!this.gate) return;
    const url = this.current.url;
    const why = await this.gate({ ...req, url, site: siteOf(url) ?? url, screenshot: await this.snapshot() });
    if (why) throw new Error(`Not done: ${why}. Try another way, or answer with what you have.`);
  }

  /** A screenshot with the current target outlined, for an approval request. */
  async snapshot(): Promise<string | undefined> {
    try {
      await this.evaluate("(() => { const el = window.__mcTarget; if (el) { el.__mcOutline = el.style.outline; el.style.outline = '4px solid #f59e0b'; el.style.outlineOffset = '2px'; } return true; })()");
      const { data } = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, this.sessionId);
      return data as string;
    } catch {
      return undefined;
    } finally {
      await this.evaluate("(() => { const el = window.__mcTarget; if (el) { el.style.outline = el.__mcOutline || ''; el.style.outlineOffset = ''; } return true; })()").catch(() => {});
    }
  }

  async scroll(direction: "down" | "up" = "down"): Promise<string> {
    await this.evaluate(`window.scrollBy(0, ${direction === "up" ? -700 : 700}), true`);
    await new Promise((r) => setTimeout(r, 400));
    return `Scrolled ${direction}`;
  }

  async back(): Promise<string> {
    const { currentIndex, entries } = await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId);
    if (currentIndex <= 0) return "Already at the first page";
    // Pages restored from the back/forward cache fire no load event, so don't wait long
    const load = this.waitForLoad(3000);
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id }, this.sessionId);
    await load;
    await this.settle(false);
    return `Went back to ${this.current.url}`;
  }

  async close() {
    try {
      await this.cdp.send("Page.stopScreencast", {}, this.sessionId);
      await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
      if (this.contextId) await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId });
    } catch {
      // Chrome may already be gone
    }
    this.cdp?.close();
  }
}
