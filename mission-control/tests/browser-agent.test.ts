import assert from "node:assert/strict";
import { test } from "node:test";
import { insteadOfGoogle, searchResultTarget } from "../src/hq/browser";
import type { BrowserSession, PageState } from "../src/hq/browser";
import { handoffRefusal, numberedLink, runBrowserAgent } from "../src/hq/browser-agent";
import type { JsonChat } from "../src/hq/ollama";
import { needsWeb, routeTask } from "../src/hq/team";

const blank: PageState = { url: "about:blank", title: "", text: "", links: [], fields: [] };
const results: PageState = {
  url: "https://html.duckduckgo.com/html/?q=pizza",
  title: "pizza at DuckDuckGo",
  text: "Results for pizza",
  links: [
    { text: "Pizza - Wikipedia", href: "https://en.wikipedia.org/wiki/Pizza" },
    { text: "Easy pizza recipe", href: "https://example.com/pizza" },
    { text: "Pizza history", href: "https://example.org/history" },
  ],
  fields: [],
};

/** A fake browser: navigate opens the page it's given; click always fails. */
function fakeSession(pages: Record<string, PageState>) {
  let current = blank;
  const calls: string[] = [];
  const session = {
    async navigate(url: string) {
      calls.push(`navigate ${url}`);
      current = pages[url] ?? { ...blank, url, title: url, text: "A page" };
      return `Opened ${url}`;
    },
    async click(target: string) {
      calls.push(`click ${target}`);
      throw new Error(`Nothing clickable matches "${target}"`);
    },
    async read() {
      return current;
    },
    async type() {
      return "typed";
    },
    async scroll() {
      return "Scrolled down";
    },
    async back() {
      return "Went back";
    },
  } as unknown as BrowserSession;
  return { session, calls };
}

/** A fake model that replies with the given actions in order (the last one repeats). */
function script(actions: Record<string, unknown>[]): JsonChat {
  let i = 0;
  return async () => actions[Math.min(i++, actions.length - 1)];
}

const base = { model: "m", maxSteps: 8, signal: new AbortController().signal, log: () => {} };

test("a handoff with no page open is refused, and the agent answers instead", async () => {
  const { session } = fakeSession({});
  let handedOff = false;
  const answer = await runBrowserAgent({
    ...base,
    task: "Good morning",
    session,
    chat: script([{ action: "handoff", text: "Please provide me with the information you need" }, { action: "answer", answer: "Good morning!" }]),
    handoff: async () => {
      handedOff = true;
      return "handed back";
    },
  });
  assert.equal(handedOff, false);
  assert.equal(answer, "Good morning!");
});

test("handoffs are only for pages that need the user, once per page", () => {
  assert.match(handoffRefusal(blank, "sign in", 0) ?? "", /no page is open/);
  assert.match(handoffRefusal(results, "Please provide the information", 0) ?? "", /nothing on this page needs the user/);
  const login = { ...results, url: "https://example.com/login", text: "Sign in to continue", fields: ["Email", "Password"] };
  assert.equal(handoffRefusal(login, "Please sign in", 0), null);
  assert.match(handoffRefusal(login, "Please sign in", 1) ?? "", /already took over/);
  const bingCheck = { ...results, url: "https://www.bing.com/search?q=pi", text: "One last step. Please solve the challenge below to continue." };
  assert.equal(handoffRefusal(bingCheck, "Please complete the challenge", 0), null);
});

test("repeating the same action is skipped, and three skips force an answer", async () => {
  const url = "https://html.duckduckgo.com/html/?q=pizza";
  const { session, calls } = fakeSession({ [url]: results });
  const answer = await runBrowserAgent({
    ...base,
    task: "how to make a pizza",
    session,
    // navigate, same page again (skip), a failing click, one retry, a third try (skip), same page (skip: forced answer)
    chat: script([
      { action: "navigate", url },
      { action: "navigate", url },
      { action: "click", target: "Order now" },
      { action: "click", target: "Order now" },
      { action: "click", target: "Order now" },
      { action: "navigate", url },
      { action: "answer", answer: "Knead, top, bake." },
    ]),
  });
  assert.equal(calls.filter((c) => c === `navigate ${url}`).length, 1);
  assert.equal(calls.filter((c) => c === "click Order now").length, 2);
  assert.equal(answer, "Knead, top, bake.");
});

test("a blocked DuckDuckGo search moves to Bing", async () => {
  const ddg = "https://html.duckduckgo.com/html/?q=node+lts";
  const botCheck = { ...blank, url: ddg, title: "DuckDuckGo", text: "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge." };
  const { session, calls } = fakeSession({ [ddg]: botCheck });
  await runBrowserAgent({ ...base, task: "node lts", session, chat: script([{ action: "navigate", url: ddg }, { action: "answer", answer: "v24" }]) });
  assert.deepEqual(calls, [`navigate ${ddg}`, "navigate https://www.bing.com/search?q=node%20lts"]);
  const wrapped = `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from("https://nodejs.org/en").toString("base64url")}&ntb=1`;
  assert.equal(searchResultTarget(wrapped), "https://nodejs.org/en");
});

test("a numbered link is opened by its number", async () => {
  const url = "https://html.duckduckgo.com/html/?q=pizza";
  const { session, calls } = fakeSession({ [url]: results });
  await runBrowserAgent({
    ...base,
    task: "pizza history",
    session,
    chat: script([{ action: "navigate", url }, { action: "click", target: "#3" }, { action: "answer", answer: "Naples." }]),
  });
  assert.deepEqual(calls, [`navigate ${url}`, "click #3", "navigate https://example.org/history"]);
  assert.equal(numberedLink(results, "[2]")?.href, "https://example.com/pizza");
  assert.equal(numberedLink(results, "link 9"), null);
  assert.equal(numberedLink(results, "Pizza history"), null);
});

test("greetings and bare replies don't go to the browser", async () => {
  const toBrowser = script([{ agent: "browser", reason: "web" }]);
  assert.equal((await routeTask(toBrowser, "m", "Good morning.")).agent, "planner");
  assert.equal((await routeTask(toBrowser, "m", "4")).agent, "planner");
  assert.equal((await routeTask(toBrowser, "m", "What's the latest news on the Mars mission?")).agent, "browser");
  assert.equal(needsWeb("find me a cheap flight to Lisbon"), true);
  assert.equal(needsWeb("Assign Browser Agent 2"), false);
});

test("a Google search becomes the same DuckDuckGo search; other Google pages and sites are left alone", () => {
  assert.equal(insteadOfGoogle("https://www.google.com/search?q=youth+arts+programs&sei=abc"), "https://html.duckduckgo.com/html/?q=youth%20arts%20programs");
  assert.equal(insteadOfGoogle("https://google.ca/?q=toronto%20theatre"), "https://html.duckduckgo.com/html/?q=toronto%20theatre");
  assert.equal(insteadOfGoogle("https://www.google.co.uk/search?q=a"), "https://html.duckduckgo.com/html/?q=a");
  assert.equal(insteadOfGoogle("https://maps.google.com/maps?q=toronto"), null);
  assert.equal(insteadOfGoogle("https://docs.google.com/document/d/x"), null);
  assert.equal(insteadOfGoogle("https://www.google.com/"), null);
  assert.equal(insteadOfGoogle("https://notgoogle.com/search?q=a"), null);
  assert.equal(insteadOfGoogle("not a url"), null);
});
