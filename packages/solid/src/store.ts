import { createContext } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { AgUiConnector } from "./connectors/agui.ts";
import { IndexedDBHistory, type ConversationSummary, type HistoryStore } from "./history.ts";
import { uid } from "./utils.ts";
import type {
  ActivityPart,
  ChatEvent,
  ChatOptions,
  ChatSettings,
  FilePart,
  McpRequest,
  Message,
  Part,
  Rating,
  StepPart,
  SubagentPart,
  Theme,
  ToolPart,
} from "./types.ts";

export type ChatController = ReturnType<typeof createChat>;

/** Controller of the chat, for components deep in the tree like widgets */
export const ChatContext = createContext<ChatController>();

const newMessage = (role: Message["role"], parts: Part[]): Message => ({
  id: uid(),
  role,
  parts,
  createdAt: new Date(),
});

/** Sub-agent part with this id, nested sub-agents included */
function findSubagent(parts: Part[], id: string): SubagentPart | undefined {
  for (const p of parts) {
    if (p.type !== "subagent") continue;
    if (p.id === id) return p;
    const nested = findSubagent(p.parts, id);
    if (nested) return nested;
  }
}

/** Activity part with this id, in sub-agents too */
function findActivity(parts: Part[], id: string): ActivityPart | undefined {
  for (const p of parts) {
    if (p.type === "activity" && p.id === id) return p;
    const nested = p.type === "subagent" ? findActivity(p.parts, id) : undefined;
    if (nested) return nested;
  }
}

/** Mark running tools, steps and sub-agents as done and end open timings, e.g. when the stream ends */
function close(parts: Part[], end: number) {
  for (const p of parts) {
    if (p.type === "tool" || p.type === "step") p.status = "done";
    if (p.type === "subagent") {
      if (p.status === "running") p.status = "done";
      close(p.parts, end);
    }
    if ("startedAt" in p && p.startedAt) p.endedAt ??= end;
  }
}

const stringify = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Apply a normalized stream event to the assistant message being streamed */
function apply(msg: Message, e: ChatEvent) {
  // Events from a sub-agent are added to its parts
  const { parts } = (e.subagent && findSubagent(msg.parts, e.subagent)) || msg;
  const last = parts[parts.length - 1];
  const tool = (id: string) => parts.find((p): p is ToolPart => p.type === "tool" && p.id === id);
  const now = Date.now();
  // A new part ends the thinking step before it
  const push = (p: Part) => {
    if (last?.type === "reasoning") last.endedAt ??= now;
    parts.push(p);
  };
  switch (e.type) {
    case "text":
      if (last?.type === "text") last.text += e.delta;
      else push({ type: "text", text: e.delta });
      break;
    case "reasoning":
      if (last?.type === "reasoning") last.text += e.delta;
      else push({ type: "reasoning", text: e.delta, startedAt: now });
      break;
    case "tool-start":
      push({ type: "tool", id: e.id, name: e.name, server: e.server, args: "", status: "running", startedAt: now });
      break;
    case "tool-args": {
      const t = tool(e.id);
      if (t) t.args += e.delta;
      break;
    }
    case "tool-result": {
      const t = tool(e.id);
      if (t) {
        t.result = stringify(e.result);
        t.status = "done";
        t.endedAt ??= now;
      }
      break;
    }
    case "step-start":
      push({ type: "step", name: e.name, status: "running", startedAt: now });
      break;
    case "step-end": {
      const step = parts.findLast(
        (p): p is StepPart => p.type === "step" && p.name === e.name && p.status === "running",
      );
      if (step) close([step], now);
      break;
    }
    case "subagent-start": {
      // A suspended sub-agent is announced again when resumed
      const sub = findSubagent(msg.parts, e.id);
      if (sub) {
        sub.status = "running";
        sub.endedAt = undefined;
      } else {
        const { id, name, description } = e;
        push({ type: "subagent", id, name, description, parts: [], status: "running", startedAt: now });
      }
      break;
    }
    case "subagent-end": {
      const sub = findSubagent(msg.parts, e.id);
      if (!sub) break;
      if (e.result !== undefined) sub.result = stringify(e.result);
      if (e.error) {
        sub.status = "error";
        sub.error = e.error;
      }
      close([sub], now);
      break;
    }
    case "activity": {
      const activity = parts.find((p): p is ActivityPart => p.type === "activity" && p.id === e.id);
      if (activity) activity.content = e.content;
      else push({ type: "activity", id: e.id, activityType: e.activityType, content: e.content });
      break;
    }
    case "state":
      msg.state = e.state;
      break;
    case "error":
      msg.error = e.message;
  }
}

const STORAGE_KEY = "light-chat-settings";

function loadSettings(): ChatSettings {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as ChatSettings;
  } catch {
    return {};
  }
}

const THEME_KEY = "light-chat-theme";

/** Theme picked by the user when the switch is enabled, otherwise the `theme` option */
function initTheme(options: ChatOptions): Theme {
  if (options.themeSwitch) {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "auto" || saved === "light" || saved === "dark") return saved;
    } catch {
      // Storage unavailable
    }
  }
  return options.theme ?? "auto";
}

type SettingsOptions = NonNullable<ChatOptions["settings"]>;

/** Settings options normalized: enabled flags, selectable values and callbacks from the options */
function settingsConfig(config: SettingsOptions = {}) {
  const values = (c: SettingsOptions["models"]) => (Array.isArray(c) ? c : (c?.values ?? []));
  const apply = (c: SettingsOptions[keyof SettingsOptions]) =>
    typeof c === "object" && !Array.isArray(c) ? c.apply : undefined;
  return {
    apiKey: !!config.apiKey,
    models: values(config.models),
    effort: values(config.effort),
    apply: { apiKey: apply(config.apiKey), model: apply(config.models), effort: apply(config.effort) },
  };
}

/** Saved settings, restricted to the enabled ones and to valid values */
function initSettings(config: ReturnType<typeof settingsConfig>): ChatSettings {
  const saved = loadSettings();
  const pick = (values: string[], value: string | undefined, fallback: number) =>
    values.length ? (value && values.includes(value) ? value : values[fallback]) : undefined;
  return {
    apiKey: config.apiKey ? saved.apiKey : undefined,
    model: pick(config.models, saved.model, 0),
    effort: pick(config.effort, saved.effort, Math.floor(config.effort.length / 2)),
  };
}

/** Conversation title: start of the first user message, or its first file name */
function titleOf(messages: Message[]) {
  const parts = messages.find((m) => m.role === "user")?.parts ?? [];
  const text = parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const file = parts.find((p) => p.type === "file");
  return text.slice(0, 80) || (file?.type === "file" ? file.name : "") || "New conversation";
}

/** Chat state and actions, used by the `Chat` component and to drive it from code */
export function createChat(options: ChatOptions) {
  if (!options.connector && !options.url) throw new Error("light-chat: provide a `url` or a `connector`");
  const [state, setState] = createStore({
    messages: [] as Message[],
    streaming: false,
    conversationId: uid(),
    conversations: [] as ConversationSummary[],
    theme: initTheme(options),
  });
  const config = settingsConfig(options.settings);
  const [settings, setSettings] = createStore(initSettings(config));
  const connector = options.connector ?? new AgUiConnector({ url: options.url ?? "" });
  const history: HistoryStore | undefined =
    options.history === false
      ? undefined
      : options.history === true || !options.history
        ? new IndexedDBHistory()
        : options.history;
  let controller: AbortController | undefined;
  // Resolves when the current response is done, so switching conversation waits for it to be saved
  let running: Promise<void> | undefined;

  const fail = (err: unknown) => options.onError?.(err instanceof Error ? err : new Error(String(err)));

  async function refreshList() {
    if (history) setState("conversations", await history.list());
  }

  // Saves run one after the other, so a slow early save can not overwrite a later one
  let saving = Promise.resolve();

  /** Save the current conversation, a snapshot is sent so stores never hold live objects */
  function persist() {
    if (!history || !state.messages.length) return saving;
    const messages = structuredClone(unwrap(state.messages));
    const conversation = {
      id: state.conversationId,
      title: titleOf(messages),
      messages,
      createdAt: messages[0].createdAt,
      updatedAt: new Date(),
    };
    saving = saving.then(async () => {
      try {
        await history.save(conversation);
        await refreshList();
      } catch (err) {
        fail(err);
      }
    });
    return saving;
  }

  async function send(text: string, files: FilePart[] = []) {
    text = text.trim();
    if ((!text && !files.length) || state.streaming) return;
    let finished!: () => void;
    running = new Promise((resolve) => (finished = resolve));
    const parts: Part[] = text ? [...files, { type: "text", text }] : files;
    setState("messages", (m) => [...m, newMessage("user", parts)]);
    const messages = [...unwrap(state.messages)];
    setState("messages", (m) => [...m, newMessage("assistant", [])]);
    void persist();
    const i = state.messages.length - 1;
    const ctrl = (controller = new AbortController());
    setState("streaming", true);
    const threadId = state.conversationId;
    const ctx = { messages, settings: { ...settings }, apply: config.apply, signal: ctrl.signal, threadId };
    const events = connector.stream(ctx)[Symbol.asyncIterator]();
    // Race each event against abort, so stop() is immediate even if a connector ignores the signal
    const aborted = new Promise<never>((_, reject) =>
      ctrl.signal.addEventListener("abort", () => reject(ctrl.signal.reason)),
    );
    aborted.catch(() => {});
    try {
      for (;;) {
        const { value, done } = await Promise.race([events.next(), aborted]);
        if (done) break;
        setState(
          "messages",
          i,
          produce((m) => apply(m, value)),
        );
      }
    } catch (err) {
      if (!ctrl.signal.aborted) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState("messages", i, "error", error.message);
        options.onError?.(error);
      }
    } finally {
      void events.return?.();
      // Tools without result (client-side or interrupted) and open steps are considered done when the stream ends
      const end = Date.now();
      setState(
        "messages",
        i,
        produce((m) => {
          m.endedAt = end;
          close(m.parts, end);
        }),
      );
      setState("streaming", false);
      controller = undefined;
      await persist();
      finished();
    }
  }

  function rate(id: string, rating: Exclude<Rating, null>) {
    const i = state.messages.findIndex((m) => m.id === id);
    if (i < 0) return;
    // Clicking the active rating again clears it
    const next = state.messages[i].rating === rating ? null : rating;
    setState("messages", i, "rating", next);
    options.onRate?.(unwrap(state.messages[i]), next);
    void persist();
  }

  function setSetting<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) {
    setSettings(key, value);
    try {
      // Merge with saved values, so settings disabled in this chat are kept
      const enabled = Object.entries(settings).filter(([, v]) => v !== undefined);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadSettings(), ...Object.fromEntries(enabled) }));
    } catch {
      // Storage unavailable (private mode, blocked), settings still apply to this session
    }
  }

  function setTheme(theme: Theme) {
    setState("theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage unavailable, the theme still applies to this session
    }
  }

  const stop = () => controller?.abort();

  /** Send an MCP request of a widget to its server through the connector */
  async function mcpRequest(request: McpRequest) {
    if (!connector.mcpRequest) throw new Error("The connector does not support MCP requests from widgets");
    return connector.mcpRequest(request, {
      settings: { ...settings },
      apply: config.apply,
      threadId: state.conversationId,
    });
  }

  /** Save the context a widget gives to the model, sent with the next requests */
  function setWidgetContext(activityId: string, context: unknown) {
    const i = state.messages.findIndex((m) => findActivity(m.parts, activityId));
    if (i < 0) return;
    setState(
      "messages",
      i,
      produce((m) => (findActivity(m.parts, activityId)!.context = context)),
    );
    // Saved with the response when it is streaming
    if (!state.streaming) void persist();
  }

  /** Stop the current response and wait for it to be saved before switching conversation */
  async function settle() {
    stop();
    await running;
  }

  /** Start a new empty conversation */
  async function newConversation() {
    await settle();
    setState({ messages: [], conversationId: uid() });
  }

  async function openConversation(id: string) {
    if (!history || id === state.conversationId) return;
    await settle();
    try {
      const conversation = await history.get(id);
      if (!conversation) return;
      // Dates may come back as strings from custom stores
      const messages = conversation.messages.map((m) => ({ ...m, createdAt: new Date(m.createdAt) }));
      setState({ messages, conversationId: id });
    } catch (err) {
      fail(err);
    }
  }

  async function deleteConversation(id: string) {
    if (!history) return;
    if (id === state.conversationId) await newConversation();
    // A queued save would bring the conversation back
    await saving;
    try {
      await history.delete(id);
      await refreshList();
    } catch (err) {
      fail(err);
    }
  }

  refreshList().catch(fail);

  return {
    state,
    settings,
    config,
    options,
    history,
    send,
    stop,
    rate,
    mcpRequest,
    setWidgetContext,
    setSetting,
    setTheme,
    newConversation,
    openConversation,
    deleteConversation,
  };
}
