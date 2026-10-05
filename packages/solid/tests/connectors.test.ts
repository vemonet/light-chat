import { afterEach, expect, test, vi } from "vite-plus/test";
import { AgUiConnector } from "../src/connectors/agui.ts";
import { sse, toTurns, type Connector, type ConnectorContext } from "../src/connectors/base.ts";
import { OpenAIConnector } from "../src/connectors/openai.ts";
import type { ChatEvent, ChatSettings, Message } from "../src/types.ts";

/** Response streaming the given SSE payload split in small chunks, to exercise buffering */
const sseResponse = (payload: string) => {
  const bytes = new TextEncoder().encode(payload);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
  );
};
const events = (items: unknown[]) =>
  items.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("");

/** Stub fetch with an SSE response, returns the mock to inspect requests */
const stubFetch = (items: unknown[]) => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => sseResponse(events(items)));
  vi.stubGlobal("fetch", fetch);
  return fetch;
};
const requestBody = (fetch: ReturnType<typeof stubFetch>) => JSON.parse(fetch.mock.calls[0][1].body as string);

const user = (text: string): Message => ({
  id: "u",
  role: "user",
  parts: [{ type: "text", text }],
  createdAt: new Date(),
});
const ctx = (messages: Message[] = [user("hi")], settings: ChatSettings = {}): ConnectorContext => ({
  messages,
  settings,
  signal: new AbortController().signal,
  threadId: "t",
});
const collect = async (connector: Connector, c = ctx()) => {
  const out: ChatEvent[] = [];
  for await (const e of connector.stream(c)) out.push(e);
  return out;
};

const assistant: Message = {
  id: "a",
  role: "assistant",
  createdAt: new Date(),
  parts: [
    { type: "reasoning", text: "hmm" },
    { type: "text", text: "Let me check." },
    { type: "tool", id: "t1", name: "search", args: '{"q":"x"}', result: "found", status: "done" },
    { type: "tool", id: "t2", name: "client_only", args: "{}", status: "done" },
    { type: "text", text: "Done." },
  ],
};
const withFiles: Message = {
  ...user("look"),
  parts: [
    { type: "file", name: "a.png", mimeType: "image/png", data: "data:image/png;base64,AAA" },
    { type: "file", name: "b.pdf", mimeType: "application/pdf", data: "data:application/pdf;base64,BBB" },
    { type: "text", text: "look" },
  ],
};

afterEach(() => vi.unstubAllGlobals());

test("sse parses multi-line data and ignores other fields", async () => {
  const res = sseResponse("event: x\ndata: a\ndata: b\n\n: comment\n\ndata: c\r\n\r\ndata: d");
  const out: string[] = [];
  for await (const d of sse(res)) out.push(d);
  expect(out).toEqual(["a\nb", "c", "d"]);
});

test("toTurns splits assistant messages around tool calls and drops unanswered calls", () => {
  expect(toTurns([user("hi"), assistant]).map((t) => t.role)).toEqual(["user", "assistant", "tool", "assistant"]);
});

test("openai connector maps content, reasoning and tool call deltas", async () => {
  const fetch = stubFetch([
    { choices: [{ delta: { reasoning_content: "think" } }] },
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
    "[DONE]",
  ]);
  expect(await collect(new OpenAIConnector({ url: "http://test", body: { model: "m0" } }))).toEqual([
    { type: "reasoning", delta: "think" },
    { type: "text", delta: "Hel" },
    { type: "text", delta: "lo" },
    { type: "tool-start", id: "c1", name: "search" },
    { type: "tool-args", id: "c1", delta: '{"q":' },
    { type: "tool-args", id: "c1", delta: '"x"}' },
  ]);
  expect(requestBody(fetch)).toEqual({ model: "m0", stream: true, messages: [{ role: "user", content: "hi" }] });
});

test("openai connector sends settings, tool history and files", async () => {
  const fetch = stubFetch(["[DONE]"]);
  const settings = { apiKey: "sk-1", model: "m1", effort: "high" };
  await collect(new OpenAIConnector({ url: "http://test" }), ctx([user("hi"), assistant, withFiles], settings));
  expect((fetch.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer sk-1");
  expect(requestBody(fetch)).toMatchObject({
    model: "m1",
    reasoning_effort: "high",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "Let me check.",
        tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
      },
      { role: "tool", tool_call_id: "t1", content: "found" },
      { role: "assistant", content: "Done." },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          { type: "file", file: { filename: "b.pdf", file_data: "data:application/pdf;base64,BBB" } },
        ],
      },
    ],
  });
});

test("agui connector maps text, tool calls and results", async () => {
  const fetch = stubFetch([
    { type: "RUN_STARTED" },
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "Hi" },
    { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "search" },
    { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{}" },
    { type: "TOOL_CALL_END", toolCallId: "t1" },
    { type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "ok" },
    { type: "RUN_ERROR", message: "boom" },
  ]);
  expect(await collect(new AgUiConnector({ url: "http://test" }), ctx([withFiles], { model: "m1" }))).toEqual([
    { type: "text", delta: "Hi" },
    { type: "tool-start", id: "t1", name: "search" },
    { type: "tool-args", id: "t1", delta: "{}" },
    { type: "tool-result", id: "t1", result: "ok" },
    { type: "error", message: "boom" },
  ]);
  expect(requestBody(fetch)).toMatchObject({
    threadId: "t",
    forwardedProps: { model: "m1" },
    messages: [
      {
        id: "u",
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "binary", mimeType: "image/png", filename: "a.png", data: "AAA" },
          { type: "binary", mimeType: "application/pdf", filename: "b.pdf", data: "BBB" },
        ],
      },
    ],
  });
});

test("http errors are thrown with status", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 401, statusText: "Unauthorized" }));
  await expect(collect(new OpenAIConnector({ url: "http://test" }))).rejects.toThrow("401 Unauthorized nope");
});

test("settings targets defined in options replace the connector defaults", async () => {
  const fetch = stubFetch(["[DONE]"]);
  const c = {
    ...ctx([user("hi")], { apiKey: "k1", model: "m1", effort: "high" }),
    targets: {
      apiKey: { header: "X-Api-Key" },
      model: { query: "model", body: "options.llm.name" },
      effort: { header: "X-Effort", prefix: "level-" },
    },
  };
  await collect(new OpenAIConnector({ url: "http://test/chat?v=1" }), c);
  const [url, init] = fetch.mock.calls[0];
  const headers = init.headers as Record<string, string>;
  expect(url).toBe("http://test/chat?v=1&model=m1");
  expect(headers["X-Api-Key"]).toBe("k1");
  expect(headers["X-Effort"]).toBe("level-high");
  expect(headers.Authorization).toBeUndefined();
  const body = requestBody(fetch);
  expect(body.options).toEqual({ llm: { name: "m1" } });
  expect(body.model).toBeUndefined();
  expect(body.reasoning_effort).toBeUndefined();
});
