import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { build, preview, type PreviewServer } from "vite-plus";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

// End user tests of the demo: built like for GitHub Pages, served under a sub path, driven in Chromium

const root = join(import.meta.dirname, "..");
let outDir: string;
let server: PreviewServer;
let browser: Browser;
let url: string;
let page: Page;
let errors: string[];

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "light-chat-demo-"));
  await build({ root, logLevel: "warn", build: { outDir, emptyOutDir: true } });
  // Built with a relative base, served under /light-chat/ like https://<user>.github.io/light-chat/
  server = await preview({ root, base: "/light-chat/", build: { outDir }, preview: { port: 0, open: false } });
  url = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

// Fresh context per test: empty IndexedDB history and localStorage
beforeEach(async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
  page = await context.newPage();
  errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url);
});

afterEach(async () => {
  await page.context().close();
  expect(errors).toEqual([]);
});

const input = () => page.getByRole("textbox", { name: "Message" });
const answer = () => page.locator(".lc-assistant").last();

/** Type a question, send it with Enter and wait for the whole answer */
async function ask(question: string) {
  await input().fill(question);
  await input().press("Enter");
  await waitForAnswer();
}
const waitForAnswer = () => page.getByRole("button", { name: "Send" }).waitFor({ timeout: 15_000 });

/** Expand the thinking step and return what the mock backend received */
async function received() {
  await answer().getByText("Thought process").click();
  return answer().locator(".lc-reasoning").innerText();
}

test("the demo loads with assets resolved under the sub path", async () => {
  await expect(page.title()).resolves.toBe("light-chat playground");
  await page.getByRole("heading", { name: "How can I help you today?" }).waitFor();
  expect(await page.getByRole("button", { name: "What is the weather in Lausanne?" }).isVisible()).toBe(true);
  expect(await page.locator("#light-chat-styles").count()).toBe(1);
});

describe.each(["agui", "openai"])("%s protocol", (protocol) => {
  test("streams reasoning, a tool call and markdown", async () => {
    await page.locator("#protocol").selectOption(protocol);
    await ask("What is the weather?");

    await expect(page.locator(".lc-user .lc-bubble").innerText()).resolves.toBe("What is the weather?");
    await answer().getByRole("heading", { name: "Weather in Lausanne" }).waitFor();
    expect(await answer().locator("table tbody tr").count()).toBe(2);
    expect(await answer().locator("pre code.hljs").innerText()).toContain("def weather(city: str)");
    expect(await answer().getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://wttr.in/:help");

    // Tool call with its arguments, the result is only sent back by AG-UI
    await answer().getByText("Get weather").click();
    expect(await answer().locator(".lc-tool-code").first().innerText()).toContain('"city": "Lausanne"');
    expect(await answer().getByText("Result").count()).toBe(protocol === "agui" ? 1 : 0);

    expect(await received()).toContain(
      'The user asked: "What is the weather?". Received model qwen-3.8, effort medium, API key no, 0 file(s).',
    );
  });
});

test("the weather MCP App widget calls its tool and sends messages", async () => {
  await page.getByRole("button", { name: "Show the weather widget" }).click();
  await waitForAnswer();
  const app = page.frameLocator(".lc-widget iframe");
  await app.getByText("Weather in Lausanne").waitFor();
  await app.getByRole("button", { name: "Refresh" }).click();
  await app.getByRole("button", { name: "Ask for the forecast" }).click();
  await page.locator(".lc-user .lc-bubble", { hasText: "What is the forecast in Lausanne?" }).waitFor();
});

test("model, effort, API key and files picked by the user are sent to the backend", async () => {
  await page.getByRole("button", { name: "Model" }).click();
  await page.getByRole("menuitemradio", { name: "gpt-5" }).click();

  await page.getByRole("button", { name: "Effort: medium" }).click();
  await page.getByRole("slider").fill("3");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Effort: high" }).waitFor();

  await page.getByRole("button", { name: "API key" }).click();
  await page.getByPlaceholder("Paste your key").fill("sk-demo");
  await page.getByPlaceholder("Paste your key").press("Enter");

  await page
    .locator("input[type=file]")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await page.getByRole("button", { name: "Remove notes.txt" }).waitFor();
  await ask("Use my settings");

  expect(await page.locator(".lc-user .lc-file-name").innerText()).toBe("notes.txt");
  expect(await received()).toContain("Received model gpt-5, effort high, API key yes, 1 file(s).");

  // Settings are remembered after a reload
  await page.reload();
  expect(await page.getByRole("button", { name: "Model" }).innerText()).toBe("gpt-5");
});

test("the user can stop a response while it streams", async () => {
  await page.getByRole("button", { name: "What is the weather in Lausanne?" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await waitForAnswer();
  // Stopped before the end of the answer, without error
  await page.waitForTimeout(300);
  expect(await answer().getByRole("heading", { name: "Weather in Lausanne" }).count()).toBe(0);
  expect(await answer().locator(".lc-error").count()).toBe(0);
  // A new question can be sent right away
  await ask("Second try");
  await answer().getByRole("heading", { name: "Weather in Lausanne" }).waitFor();
});

test("conversations are kept in the history across reloads", async () => {
  await ask("First conversation");
  await page.getByRole("button", { name: "New session" }).click();
  await page.getByRole("heading", { name: "How can I help you today?" }).waitFor();
  await ask("Second conversation");

  await page.reload();
  await page.getByRole("button", { name: "Open sidebar" }).click();
  const sidebar = page.getByRole("complementary", { name: "Conversations" });
  await sidebar.getByRole("button", { name: "First conversation", exact: true }).click();
  await page.locator(".lc-user .lc-bubble", { hasText: "First conversation" }).waitFor();
  await answer().getByRole("heading", { name: "Weather in Lausanne" }).waitFor();

  // The delete button shows when hovering the row
  await sidebar.getByRole("button", { name: "Second conversation", exact: true }).hover();
  await sidebar.getByRole("button", { name: "Delete Second conversation" }).click();
  await sidebar.getByRole("button", { name: "Second conversation", exact: true }).waitFor({ state: "detached" });
  expect(await sidebar.locator(".lc-conversation-title").allInnerTexts()).toEqual(["First conversation"]);
});

test("answers can be rated and code blocks copied", async () => {
  const rated: string[] = [];
  page.on("console", (m) => m.text().startsWith("rated") && rated.push(m.text()));
  await ask("Rate me");

  await answer().hover();
  await answer().getByRole("button", { name: "Good response" }).click();
  expect(await answer().getByRole("button", { name: "Good response" }).getAttribute("aria-pressed")).toBe("true");
  await expect.poll(() => rated).toEqual([expect.stringMatching(/^rated up/)]);

  await answer().locator(".lc-code").hover();
  await answer().locator(".lc-code-copy").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("import httpx");
});

test("dark theme and phone sized screens", async () => {
  await page.locator("#theme").selectOption("dark");
  expect(await page.locator(".lc-root").evaluate((el) => getComputedStyle(el).colorScheme)).toBe("dark");

  await page.setViewportSize({ width: 375, height: 812 });
  await ask("Small screen");
  await answer().getByRole("heading", { name: "Weather in Lausanne" }).waitFor();
  // No horizontal page scroll, wide content scrolls inside the message
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
