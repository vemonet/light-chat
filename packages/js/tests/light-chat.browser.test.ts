import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  IndexedDBHistory,
  Chat,
  OpenAIConnector,
  type ChatEvent,
  type ChatOptions,
  type Connector,
  type ConnectorContext,
  type Conversation,
  type HistoryStore,
  type McpRequest,
} from "../src/index.ts";
import weatherApp from "../../../demo/weather-app.html?raw";

// Runs in a real Chromium (see the "browser" project in the root vite.config.ts)

/** Connector replaying a script, each request context is recorded in `calls` */
function fakeConnector(script: (ctx: ConnectorContext) => AsyncIterable<ChatEvent>) {
  const calls: ConnectorContext[] = [];
  const connector: Connector = {
    stream(ctx) {
      calls.push(ctx);
      return script(ctx);
    },
  };
  return { connector, calls };
}

/** Connector answering every message with the given events */
const replying = (...events: ChatEvent[]) =>
  fakeConnector(async function* () {
    yield* events;
  });

/** Connector sending some text, then never ending and ignoring the abort signal */
const hanging = (...events: ChatEvent[]) =>
  fakeConnector(async function* () {
    yield* events;
    await new Promise(() => {});
  });

const text = (delta: string): ChatEvent => ({ type: "text", delta });

/** History kept in memory, copies are stored like a real database would */
class MemoryHistory implements HistoryStore {
  items = new Map<string, Conversation>();
  async list() {
    return [...this.items.values()]
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }
  async get(id: string) {
    return structuredClone(this.items.get(id));
  }
  async save(c: Conversation) {
    this.items.set(c.id, structuredClone(c));
  }
  async delete(id: string) {
    this.items.delete(id);
  }
}

let el: HTMLDivElement;
const chats: Chat[] = [];
// Chats with a history change the page URL
const initialUrl = location.href;

/** Mount a chat in the test container, history disabled unless given */
const mount = (options: ChatOptions, target: string | HTMLElement = el) => {
  const chat = new Chat(target, { history: false, ...options });
  chats.push(chat);
  return chat;
};
const ui = () => page.elementLocator(el);
const input = () => ui().getByRole("textbox", { name: "Message" });

beforeEach(() => {
  localStorage.clear();
  el = document.createElement("div");
  el.id = "chat";
  el.style.height = "600px";
  document.body.append(el);
});

afterEach(() => {
  for (const chat of chats.splice(0)) chat.destroy();
  el.remove();
  vi.unstubAllGlobals();
  history.replaceState(null, "", initialUrl);
});

test("mounts into an element id, a #id selector or an element, and unmounts on destroy", () => {
  for (const target of ["chat", "#chat", el]) {
    const chat = new Chat(target, { connector: replying().connector, history: false });
    expect(el.querySelector(".lc-root")).not.toBeNull();
    chat.destroy();
    expect(el.innerHTML).toBe("");
  }
});

test("throws when the element is missing or no backend is set", () => {
  expect(() => new Chat("missing", { url: "/api" })).toThrow('light-chat: element "missing" not found');
  expect(() => new Chat(el)).toThrow("provide a `url` or a `connector`");
});

test("shows the welcome message and sends an example question when clicked", async () => {
  const { connector, calls } = replying(text("Pong"));
  mount({ connector, welcome: "## Hello there", examples: ["Ping?", "Other"] });
  await expect.element(ui().getByRole("heading", { name: "Hello there" })).toBeVisible();

  await ui().getByRole("button", { name: "Ping?" }).click();
  await expect.element(ui().getByText("Pong")).toBeVisible();
  expect(calls[0].messages.at(-1)?.parts).toEqual([{ type: "text", text: "Ping?" }]);
  // Welcome and examples are replaced by the thread
  expect(el.querySelector(".lc-welcome")).toBeNull();
});

test("streams reasoning, tool calls and markdown into the thread", async () => {
  const { connector } = replying(
    { type: "reasoning", delta: "Need the " },
    { type: "reasoning", delta: "weather." },
    text("Checking."),
    { type: "tool-start", id: "t1", name: "get_weather" },
    { type: "tool-args", id: "t1", delta: '{"city":' },
    { type: "tool-args", id: "t1", delta: '"Lausanne"}' },
    { type: "tool-result", id: "t1", result: { temperature: 18 } },
    text("It is **18 C** in "),
    text("`Lausanne`"),
  );
  const chat = mount({ connector });
  await chat.send("  Weather?  ");

  // State exposed by the class
  const [user, answer] = chat.messages;
  expect(user.role).toBe("user");
  expect(user.parts).toEqual([{ type: "text", text: "Weather?" }]);
  expect(answer.role).toBe("assistant");
  expect(answer.parts.map((p) => p.type)).toEqual(["reasoning", "text", "tool", "text"]);
  expect(answer.parts[0]).toMatchObject({ text: "Need the weather." });
  expect(answer.parts[2]).toMatchObject({
    name: "get_weather",
    args: '{"city":"Lausanne"}',
    result: JSON.stringify({ temperature: 18 }, null, 2),
    status: "done",
  });
  expect(answer.endedAt).toBeTypeOf("number");

  // Rendered thread
  await expect.element(ui().getByText("Weather?", { exact: true })).toBeVisible();
  await expect.element(ui().getByText("Thought process")).toBeVisible();
  await expect.element(ui().getByText("18 C")).toHaveProperty("tagName", "STRONG");
  await expect.element(ui().getByText("Lausanne", { exact: true })).toHaveProperty("tagName", "CODE");

  // Tool calls expand to show the arguments and result
  await ui().getByText("Get weather").click();
  await expect.element(ui().getByText("Arguments")).toBeVisible();
  await expect.element(ui().getByText("Result")).toBeVisible();
  await expect.element(ui().getByText('"temperature"')).toBeVisible();
});

test("streams steps, activities and nested sub-agents, and keeps the agent state", async () => {
  const { connector, calls } = replying(
    { type: "step-start", name: "plan_work" },
    { type: "activity", id: "a1", activityType: "PLAN", content: { steps: ["search"] } },
    { type: "activity", id: "a1", activityType: "PLAN", content: { title: "Plan ready", steps: ["search", "write"] } },
    { type: "step-end", name: "plan_work" },
    { type: "subagent-start", id: "s1", name: "researcher", description: "Finds sources" },
    { type: "tool-start", id: "t1", name: "search", subagent: "s1" },
    { type: "tool-result", id: "t1", result: "2 hits", subagent: "s1" },
    { type: "subagent-start", id: "s2", name: "reader", subagent: "s1" },
    { type: "text", delta: "Read both", subagent: "s2" },
    { type: "subagent-end", id: "s2", error: "timeout" },
    { type: "text", delta: "Found 2 sources", subagent: "s1" },
    { type: "subagent-end", id: "s1", result: "Found 2 sources" },
    { type: "state", state: { done: true } },
    text("Summary"),
  );
  const chat = mount({ connector });
  await chat.send("Research");

  const answer = chat.messages[1];
  expect(answer.state).toEqual({ done: true });
  expect(answer.parts).toMatchObject([
    { type: "step", name: "plan_work", status: "done" },
    { type: "activity", id: "a1", content: { title: "Plan ready", steps: ["search", "write"] } },
    {
      type: "subagent",
      name: "researcher",
      status: "done",
      result: "Found 2 sources",
      parts: [
        { type: "tool", name: "search", result: "2 hits", status: "done" },
        { type: "subagent", name: "reader", status: "error", error: "timeout", parts: [{ text: "Read both" }] },
        { type: "text", text: "Found 2 sources" },
      ],
    },
    { type: "text", text: "Summary" },
  ]);

  // Steps are grouped in one line, expanding to steps, activities and sub-agents
  await ui().getByText("1 sub-agent · 1 step · 1 update").click();
  await expect.element(ui().getByText("Plan work")).toBeVisible();
  await ui().getByText("Plan ready").click();
  await expect.element(ui().getByText('"write"')).toBeVisible();
  await ui().getByText("Researcher").click();
  await expect.element(ui().getByText("Finds sources")).toBeVisible();
  await expect.element(ui().getByText("Found 2 sources")).toBeVisible();
  await ui().getByText("1 tool call · 1 sub-agent").click();
  await ui().getByText("Reader · failed").click();
  await expect.element(ui().getByText("timeout")).toBeVisible();
  await expect.element(ui().getByText("Summary")).toBeVisible();

  // The state is in the history sent with the next message
  await chat.send("Next");
  expect(calls[1].messages[1].state).toEqual({ done: true });
});

/** Connector replying with a tool UI activity, MCP requests of the widget are recorded and answered */
function widgetConnector(content: unknown, answer: (r: McpRequest) => unknown) {
  const fake = replying(
    { type: "tool-start", id: "t1", name: "get_weather" },
    { type: "tool-result", id: "t1", result: "{}" },
    { type: "activity", id: "w1", activityType: "mcp-apps", content },
  );
  const requests: McpRequest[] = [];
  fake.connector.mcpRequest = async (r) => (requests.push(r), answer(r));
  return { ...fake, requests };
}

test("MCP Apps get the tool input and result, and call tools, update the model context and send messages", async () => {
  // Content from the AG-UI MCP Apps middleware, with the resource URI and a server hash
  const { connector, calls, requests } = widgetConnector(
    {
      resourceUri: "ui://weather/app.html",
      serverHash: "h1",
      toolInput: { city: "Lausanne" },
      result: { content: [], structuredContent: { temperature: 18, condition: "Sunny" } },
    },
    (r) =>
      r.method === "resources/read"
        ? { contents: [{ uri: "ui://weather/app.html", mimeType: "text/html;profile=mcp-app", text: weatherApp }] }
        : r.method === "tools/list"
          ? { tools: [{ name: "get_weather" }] }
          : { content: [], structuredContent: { temperature: 21, condition: "Windy" } },
  );
  const chat = mount({ connector });
  await chat.send("Weather?");

  // The iframe has an opaque origin: its content can be clicked but not inspected, effects are checked instead
  const app = page.frameLocator(ui().getByTitle("Tool UI").first());
  expect(requests[0]).toEqual({ serverHash: "h1", method: "resources/read", params: { uri: "ui://weather/app.html" } });
  // Sandboxed with the default CSP, sized by the app
  const iframe = el.querySelector("iframe")!;
  expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  expect(iframe.srcdoc).toContain("connect-src 'none'");
  // Resized by the app once it shows the tool result
  await expect.poll(() => iframe.style.height).not.toBe("160px");

  // Tool call with the city from the tool input, once its visibility is checked, then context for the model
  await app.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[1]).toEqual({ serverHash: "h1", method: "tools/list" });
  expect(requests[2]).toEqual({
    serverHash: "h1",
    method: "tools/call",
    params: { name: "get_weather", arguments: { city: "Lausanne" } },
  });
  await expect
    .poll(() => chat.messages[1].parts.find((p) => p.type === "activity"))
    .toMatchObject({
      context: { content: [{ type: "text", text: "The widget shows 21 C in Lausanne" }] },
    });

  await app.getByRole("button", { name: "Ask for the forecast" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[1].messages.at(-1)?.parts).toEqual([{ type: "text", text: "What is the forecast in Lausanne?" }]);
});

test("MCP-UI resources run their prompt and tool actions, only for tools visible to apps", async () => {
  const tool = (name: string) =>
    `parent.postMessage({type: 'tool', messageId: '${name}', payload: {toolName: '${name}', params: {name: 'Ada'}}}, '*')`;
  const html = `<button onclick="${tool("nudge")}">Nudge</button>
    <button onclick="${tool("secret")}">Secret</button>
    <button onclick="parent.postMessage({type: 'prompt', payload: {prompt: 'Hi from the UI'}}, '*')">Ask</button>
    <script>
      // The tool response or error is sent back as a prompt, to check it from the host
      addEventListener('message', ({data: d}) => d.type === 'ui-message-response' && parent.postMessage(
        {type: 'prompt', payload: {prompt: d.payload.error ?? d.payload.response.content[0].text}}, '*'))
    </script>`;
  const resource = { uri: "ui://team/1", mimeType: "text/html", text: html };
  // Content from the light-chat server: server id, raw result and tool `_meta`
  const { connector, calls, requests } = widgetConnector(
    { serverId: "s2", tool: { name: "show_team" }, result: { content: [{ type: "resource", resource }] } },
    (r) =>
      r.method === "tools/list"
        ? { tools: [{ name: "nudge" }, { name: "secret", _meta: { ui: { visibility: ["model"] } } }] }
        : { content: [{ type: "text", text: "Nudged Ada" }] },
  );
  const chat = mount({ connector });
  await chat.send("Team?");

  const app = page.frameLocator(ui().getByTitle("Tool UI").first());
  await app.getByRole("button", { name: "Nudge" }).click();
  await expect.poll(() => calls.length).toBe(2);
  expect(requests).toEqual([
    { serverId: "s2", method: "tools/list" },
    { serverId: "s2", method: "tools/call", params: { name: "nudge", arguments: { name: "Ada" } } },
  ]);
  expect(chat.messages[2].parts).toEqual([{ type: "text", text: "Nudged Ada" }]);

  // Tools only visible to the model can not be called by the UI
  await app.getByRole("button", { name: "Secret" }).click();
  await expect.poll(() => calls.length).toBe(3);
  expect(chat.messages[4].parts).toEqual([{ type: "text", text: "Tool secret is not available to apps" }]);
  expect(requests).toHaveLength(2);

  await app.getByRole("button", { name: "Ask" }).click();
  await expect.poll(() => calls.length).toBe(4);
  expect(chat.messages[6].parts).toEqual([{ type: "text", text: "Hi from the UI" }]);
});

test("tool results without UI are not shown", async () => {
  const { connector } = widgetConnector(
    { serverId: "s1", tool: { name: "read_me" }, result: { content: [{ type: "text", text: "docs" }] } },
    () => ({}),
  );
  const chat = mount({ connector });
  await chat.send("Docs?");
  await expect.element(ui().getByText("Get weather")).toBeVisible();
  expect(el.querySelector(".lc-widget, iframe")).toBeNull();
});

test("the connector receives the history, the default settings and the conversation id", async () => {
  const { connector, calls } = replying(text("ok"));
  const chat = mount({ connector, settings: { models: ["a", "b"], effort: ["low", "mid", "high"] } });
  await chat.send("one");
  await chat.send("two");

  expect(calls).toHaveLength(2);
  // History up to the new user message, the assistant placeholder is not sent
  expect(calls[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(calls[1].messages[1].parts).toEqual([{ type: "text", text: "ok" }]);
  expect(calls[1].threadId).toBe(chat.conversationId);
  // First model and middle effort by default
  expect(calls[1].settings).toEqual({ apiKey: undefined, model: "a", effort: "mid" });
});

test("user types a message and sends it with Enter, the input is cleared", async () => {
  const { connector, calls } = replying(text("Hi human"));
  const chat = mount({ connector, placeholder: "Ask me" });
  await expect.element(ui().getByPlaceholder("Ask me")).toBeVisible();
  await expect.element(ui().getByRole("button", { name: "Send" })).toBeDisabled();

  await userEvent.type(input(), "Hello bot{Enter}");
  await expect.element(ui().getByText("Hi human")).toBeVisible();
  await expect.element(input()).toHaveValue("");
  expect(calls).toHaveLength(1);
  expect(chat.messages[0].parts).toEqual([{ type: "text", text: "Hello bot" }]);
});

test("empty messages and messages sent while streaming are ignored", async () => {
  const { connector, calls } = hanging(text("..."));
  const chat = mount({ connector });
  await chat.send("   ");
  expect(calls).toHaveLength(0);
  expect(chat.messages).toEqual([]);

  void chat.send("first");
  await expect.element(ui().getByRole("button", { name: "Stop" })).toBeVisible();
  await chat.send("second");
  expect(calls).toHaveLength(1);
  expect(chat.messages).toHaveLength(2);
});

test("the Stop button aborts the response, keeps the partial answer and ends running tools", async () => {
  const { connector, calls } = hanging(text("Partial answer"), { type: "tool-start", id: "t1", name: "search" });
  const chat = mount({ connector });
  const sent = chat.send("Long question");

  await expect.element(ui().getByText("Partial answer")).toBeVisible();
  await ui().getByRole("button", { name: "Stop" }).click();
  // Resolves even though the connector ignores the abort signal
  await sent;

  expect(calls[0].signal.aborted).toBe(true);
  expect(chat.messages[1].parts).toMatchObject([{ text: "Partial answer" }, { name: "search", status: "done" }]);
  expect(chat.messages[1].error).toBeUndefined();
  await expect.element(ui().getByRole("button", { name: "Send" })).toBeVisible();
});

test("stop() from code aborts the response", async () => {
  const { connector, calls } = hanging(text("Partial"));
  const chat = mount({ connector });
  const sent = chat.send("question");
  await expect.element(ui().getByText("Partial")).toBeVisible();
  chat.stop();
  await sent;
  expect(calls[0].signal.aborted).toBe(true);
  expect(chat.messages[1].parts).toEqual([{ type: "text", text: "Partial" }]);
});

test("connector errors are shown under the answer and reported to onError", async () => {
  const onError = vi.fn();
  const { connector } = fakeConnector(async function* () {
    yield text("Starting");
    throw new Error("backend down");
  });
  const chat = mount({ connector, onError });
  await chat.send("hi");

  await expect.element(ui().getByText("backend down")).toBeVisible();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "backend down" }));
  expect(chat.messages[1]).toMatchObject({ error: "backend down", parts: [{ text: "Starting" }] });
});

test("error events from the backend are shown under the answer", async () => {
  const { connector } = replying(text("Hmm"), { type: "error", message: "rate limited" });
  const chat = mount({ connector });
  await chat.send("hi");
  await expect.element(ui().getByText("rate limited")).toBeVisible();
  expect(chat.messages[1].error).toBe("rate limited");
});

test("clear() starts a new empty conversation", async () => {
  const { connector, calls } = replying(text("ok"));
  const chat = mount({ connector, welcome: "## Welcome back" });
  await chat.send("hi");
  const first = chat.conversationId;

  await chat.clear();
  expect(chat.messages).toEqual([]);
  expect(chat.conversationId).not.toBe(first);
  await expect.element(ui().getByRole("heading", { name: "Welcome back" })).toBeVisible();

  // The new conversation starts without the previous history
  await chat.send("again");
  expect(calls[1].messages).toHaveLength(1);
  expect(calls[1].threadId).toBe(chat.conversationId);
});

test("clear() while streaming aborts the response", async () => {
  const { connector, calls } = hanging(text("Partial"));
  const chat = mount({ connector });
  void chat.send("question");
  await expect.element(ui().getByText("Partial")).toBeVisible();
  await chat.clear();
  expect(calls[0].signal.aborted).toBe(true);
  expect(chat.messages).toEqual([]);
});

test("conversations are saved to the history, listed in the sidebar, reopened and deleted", async () => {
  const history = new MemoryHistory();
  const { connector } = replying(text("Answer"));
  const chat = mount({ connector, history, sidebarOpen: true });
  const sidebar = ui().getByRole("complementary", { name: "Conversations" });

  await chat.send("First question");
  const firstId = chat.conversationId;
  const saved = history.items.get(firstId)!;
  expect(saved.title).toBe("First question");
  expect(saved.messages.map((m) => m.parts)).toEqual([
    [{ type: "text", text: "First question" }],
    [{ type: "text", text: "Answer" }],
  ]);

  await chat.clear();
  // Distinct update times for the sort
  await new Promise((r) => setTimeout(r, 5));
  await chat.send("Second question");
  const secondId = chat.conversationId;
  // Most recent first
  await expect.element(sidebar.getByRole("button", { name: "Second question", exact: true })).toBeVisible();
  const titles = [...el.querySelectorAll(".lc-conversation-title")].map((b) => b.textContent);
  expect(titles).toEqual(["Second question", "First question"]);

  // Reopen from code
  await chat.open(firstId);
  expect(chat.conversationId).toBe(firstId);
  expect(chat.messages[0].parts).toEqual([{ type: "text", text: "First question" }]);
  expect(chat.messages[0].createdAt).toBeInstanceOf(Date);
  await expect.element(ui().getByText("First question", { exact: true }).first()).toBeVisible();

  // Reopen from the sidebar
  await sidebar.getByRole("button", { name: "Second question", exact: true }).click();
  await expect.poll(() => chat.conversationId).toBe(secondId);
  expect(el.querySelector(".lc-current")?.textContent).toBe("Second question");

  // Deleting the open conversation starts a new one
  await sidebar.getByRole("button", { name: "Delete Second question" }).click();
  await expect.poll(() => history.items.has(secondId)).toBe(false);
  expect(chat.conversationId).not.toBe(secondId);
  expect(chat.messages).toEqual([]);
  await expect.element(sidebar.getByRole("button", { name: "Second question", exact: true })).not.toBeInTheDocument();
});

test("a slow save can not overwrite a later one", async () => {
  // Like an HTTP store where the first request is answered last
  const history = new MemoryHistory();
  const save = history.save.bind(history);
  let calls = 0;
  history.save = async (c) => {
    if (calls++ === 0) await new Promise((r) => setTimeout(r, 100));
    await save(c);
  };
  const chat = mount({ connector: replying(text("Full answer")).connector, history });
  await chat.send("question");
  await new Promise((r) => setTimeout(r, 150));
  expect(history.items.get(chat.conversationId)?.messages[1].parts).toEqual([{ type: "text", text: "Full answer" }]);
});

test("deleting a conversation right after rating it does not bring it back", async () => {
  const history = new MemoryHistory();
  const save = history.save.bind(history);
  history.save = async (c) => {
    await new Promise((r) => setTimeout(r, 300));
    await save(c);
  };
  const chat = mount({ connector: replying(text("answer")).connector, history, sidebarOpen: true, onRate: () => {} });
  await chat.send("Rate then delete");
  const id = chat.conversationId;

  await ui().getByRole("button", { name: "Good response" }).click();
  await ui().getByRole("button", { name: "Rate then delete", exact: true }).hover();
  await ui().getByRole("button", { name: "Delete Rate then delete" }).click();
  await new Promise((r) => setTimeout(r, 400));
  expect(history.items.has(id)).toBe(false);
});

test("the open conversation is kept in the URL and opened on load", async () => {
  const history = new MemoryHistory();
  const { connector } = replying(text("Answer"));
  const param = () => new URL(location.href).searchParams.get("session");
  const chat = mount({ connector, history });
  // An empty conversation is not in the URL
  expect(param()).toBeNull();
  await chat.send("Linked question");
  const id = chat.conversationId;
  await expect.poll(param).toBe(id);
  await chat.clear();
  await expect.poll(param).toBeNull();
  chat.destroy();

  // A new instance, like after loading the link, opens the conversation
  window.history.replaceState(null, "", `?session=${id}`);
  const next = mount({ connector, history });
  await expect.poll(() => next.conversationId).toBe(id);
  await expect.element(ui().getByText("Linked question", { exact: true }).first()).toBeVisible();
  next.destroy();

  // Disabled with urlParam: false
  window.history.replaceState(null, "", initialUrl);
  const off = mount({ connector, history, urlParam: false });
  await off.send("Not linked");
  expect(param()).toBeNull();
});

test("the IndexedDB history keeps conversations across page loads", async () => {
  const name = `light-chat-test-${Math.random().toString(36).slice(2)}`;
  const { connector } = replying(text("Stored answer"));
  const chat = mount({ connector, history: new IndexedDBHistory(name), sidebarOpen: true });
  await chat.send("Remember me");
  const id = chat.conversationId;
  chat.destroy();

  // A new instance, like after a reload, lists and reopens the conversation
  const next = mount({ connector, history: new IndexedDBHistory(name), sidebarOpen: true });
  await ui().getByRole("button", { name: "Remember me", exact: true }).click();
  await expect.poll(() => next.conversationId).toBe(id);
  await expect.element(ui().getByText("Stored answer")).toBeVisible();
  expect(next.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
});

test("settings picked in the toolbar are sent to the connector and remembered", async () => {
  const { connector, calls } = replying(text("ok"));
  const options: ChatOptions = { connector, settings: { apiKey: true, models: ["m1", "m2"], effort: ["low", "high"] } };
  const chat = mount(options);

  // Model menu
  await ui().getByRole("button", { name: "Model" }).click();
  await ui().getByRole("menuitemradio", { name: "m2" }).click();
  await expect.element(ui().getByRole("menu")).not.toBeInTheDocument();
  await expect.element(ui().getByRole("button", { name: "Model" })).toHaveTextContent("m2");

  // API key field, Enter closes it without sending the message
  await ui().getByRole("button", { name: "API key" }).click();
  await userEvent.type(ui().getByPlaceholder("Paste your key"), "sk-test{Enter}");
  await expect.element(ui().getByPlaceholder("Paste your key")).not.toBeInTheDocument();
  expect(calls).toHaveLength(0);

  await chat.send("hi");
  expect(calls[0].settings).toEqual({ apiKey: "sk-test", model: "m2", effort: "high" });

  // Restored by the next chat on the page
  chat.destroy();
  mount(options);
  await expect.element(ui().getByRole("button", { name: "Model" })).toHaveTextContent("m2");
});

test("saved settings that are not available anymore fall back to the defaults", async () => {
  localStorage.setItem("light-chat-settings", JSON.stringify({ model: "gone", apiKey: "sk-old" }));
  const { connector, calls } = replying(text("ok"));
  const apply = vi.fn();
  const chat = mount({ connector, settings: { models: { values: ["m1", "m2"], apply } } });
  await chat.send("hi");
  // API key setting is disabled here, so the saved key is not sent
  expect(calls[0].settings).toEqual({ apiKey: undefined, model: "m1", effort: undefined });
  expect(calls[0].apply?.model).toBe(apply);
});

test("ratings toggle and are reported to onRate", async () => {
  const onRate = vi.fn();
  const { connector } = replying(text("Rated answer"));
  const chat = mount({ connector, onRate });
  await chat.send("hi");

  const up = ui().getByRole("button", { name: "Good response" });
  await up.click();
  await expect.element(up).toHaveAttribute("aria-pressed", "true");
  expect(chat.messages[1].rating).toBe("up");
  expect(onRate).toHaveBeenLastCalledWith(expect.objectContaining({ id: chat.messages[1].id }), "up");

  // Clicking the active rating clears it, the other one replaces it
  await up.click();
  expect(onRate).toHaveBeenLastCalledWith(expect.anything(), null);
  await ui().getByRole("button", { name: "Bad response" }).click();
  expect(chat.messages[1].rating).toBe("down");
});

test("rating buttons are hidden without onRate", async () => {
  const chat = mount({ connector: replying(text("answer")).connector });
  await chat.send("hi");
  await expect.element(ui().getByRole("button", { name: "Copy message" }).first()).toBeInTheDocument();
  await expect.element(ui().getByRole("button", { name: "Good response" })).not.toBeInTheDocument();
});

test("files attached by the user are sent with the message", async () => {
  const { connector, calls } = replying(text("Got your file"));
  const chat = mount({ connector });
  const file = new File(["hello"], "note.txt", { type: "text/plain" });
  await userEvent.upload(page.elementLocator(el.querySelector("input[type=file]")!), file);

  // Shown in the composer and removable, a file alone can be sent
  await expect.element(ui().getByRole("button", { name: "Remove note.txt" })).toBeVisible();
  await ui().getByRole("button", { name: "Send" }).click();
  await expect.element(ui().getByText("Got your file")).toBeVisible();

  expect(calls[0].messages[0].parts).toEqual([
    { type: "file", name: "note.txt", mimeType: "text/plain", data: "data:text/plain;base64,aGVsbG8=" },
  ]);
  expect(chat.messages[0].parts[0]).toMatchObject({ name: "note.txt" });
  await expect.element(ui().getByRole("button", { name: "Remove note.txt" })).not.toBeInTheDocument();
});

test("files can be passed to send() and attachments can be disabled", async () => {
  const { connector, calls } = replying(text("ok"));
  const chat = mount({ connector, attachments: false });
  await expect.element(ui().getByRole("button", { name: "Add files" })).not.toBeInTheDocument();
  const png = { type: "file" as const, name: "a.png", mimeType: "image/png", data: "data:image/png;base64,AAA" };
  await chat.send("look", [png]);
  expect(calls[0].messages[0].parts).toEqual([png, { type: "text", text: "look" }]);
  await expect.element(ui().getByRole("img", { name: "a.png" })).toBeVisible();
});

test("markdown from the backend is sanitized", async () => {
  const win = window as unknown as { xss?: number };
  const { connector } = replying(
    text('Safe <img src="x" onerror="window.xss = 1"> <script>window.xss = 2</script> [link](javascript:window.xss=3)'),
  );
  const chat = mount({ connector });
  await chat.send("hi");
  await expect.element(ui().getByText("Safe")).toBeVisible();
  await new Promise((r) => setTimeout(r, 100));
  expect(win.xss).toBeUndefined();
  expect(el.querySelector("script, [onerror]")).toBeNull();
  expect(el.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
});

test("the theme option sets the color scheme", () => {
  mount({ connector: replying().connector });
  expect(getComputedStyle(el.querySelector(".lc-root")!).colorScheme).toBe("light dark");
  chats.pop()!.destroy();
  mount({ connector: replying().connector, theme: "dark" });
  expect(getComputedStyle(el.querySelector(".lc-root")!).colorScheme).toBe("dark");
});

test("destroy() aborts the response and unmounts", async () => {
  const { connector, calls } = hanging(text("Partial"));
  const chat = mount({ connector });
  const sent = chat.send("question");
  await expect.element(ui().getByText("Partial")).toBeVisible();
  chat.destroy();
  await sent;
  expect(calls[0].signal.aborted).toBe(true);
  expect(el.innerHTML).toBe("");
});

test("several chats on a page are independent and share one stylesheet", async () => {
  const other = document.createElement("div");
  document.body.append(other);
  const a = mount({ connector: replying(text("from a")).connector });
  const b = mount({ connector: replying(text("from b")).connector }, other);
  await a.send("hi a");
  expect(a.messages).toHaveLength(2);
  expect(b.messages).toHaveLength(0);
  expect(a.conversationId).not.toBe(b.conversationId);
  expect(document.querySelectorAll("#light-chat-styles")).toHaveLength(1);
  b.destroy();
  other.remove();
});

test("the default connector streams from an AG-UI endpoint", async () => {
  const sse = [
    { type: "RUN_STARTED" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "Hello from " },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "AG-UI" },
    { type: "RUN_FINISHED" },
  ]
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .join("");
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse));
  vi.stubGlobal("fetch", fetch);
  const chat = mount({ url: "/agui" });
  await chat.send("hi");

  await expect.element(ui().getByText("Hello from AG-UI")).toBeVisible();
  // Relative URLs resolve against the page, the thread id is the conversation id
  expect(fetch.mock.calls[0][0]).toBe(new URL("/agui", location.href).href);
  expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toMatchObject({ threadId: chat.conversationId });
});

test("http errors from a connector are shown to the user", async () => {
  vi.stubGlobal("fetch", async () => new Response("bad key", { status: 401, statusText: "Unauthorized" }));
  const chat = mount({ connector: new OpenAIConnector({ url: "/v1/chat/completions" }) });
  await chat.send("hi");
  await expect.element(ui().getByText("401 Unauthorized bad key")).toBeVisible();
});
