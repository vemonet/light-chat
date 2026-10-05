import { createStore, produce, unwrap } from "solid-js/store";
import { AgUiConnector } from "./connectors/agui.ts";
import { IndexedDBHistory, type ConversationSummary, type HistoryStore } from "./history.ts";
import { uid } from "./utils.ts";
import type {
  ChatEvent,
  ChatOptions,
  ChatSettings,
  FilePart,
  Message,
  Part,
  Rating,
  SettingTarget,
  SettingTargets,
  SettingValues,
  ToolPart,
} from "./types.ts";

export type ChatController = ReturnType<typeof createChat>;

const newMessage = (role: Message["role"], parts: Part[]): Message => ({
  id: uid(),
  role,
  parts,
  createdAt: new Date(),
});

/** Apply a normalized stream event to the assistant message being streamed */
function apply(msg: Message, e: ChatEvent) {
  const last = msg.parts[msg.parts.length - 1];
  const tool = (id: string) => msg.parts.find((p): p is ToolPart => p.type === "tool" && p.id === id);
  switch (e.type) {
    case "text":
    case "reasoning":
      if (last?.type === e.type) last.text += e.delta;
      else msg.parts.push({ type: e.type, text: e.delta });
      break;
    case "tool-start":
      msg.parts.push({ type: "tool", id: e.id, name: e.name, args: "", status: "running" });
      break;
    case "tool-args": {
      const t = tool(e.id);
      if (t) t.args += e.delta;
      break;
    }
    case "tool-result": {
      const t = tool(e.id);
      if (t) {
        t.result = typeof e.result === "string" ? e.result : JSON.stringify(e.result, null, 2);
        t.status = "done";
      }
      break;
    }
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

/** Settings options normalized for the UI: enabled flag and selectable values */
function settingsConfig(config: ChatOptions["settings"] = {}) {
  const values = (c?: string[] | SettingValues) => (Array.isArray(c) ? c : (c?.values ?? []));
  const apiKey = !!config.apiKey;
  const models = values(config.models);
  const effort = values(config.effort);
  return { apiKey, models, effort, enabled: apiKey || models.length > 0 || effort.length > 0 };
}

/** Targets explicitly defined in the settings options, the connector defaults apply to the others */
function settingTargets(config: ChatOptions["settings"] = {}): SettingTargets {
  const target = (c?: boolean | string[] | SettingTarget) =>
    typeof c === "object" && !Array.isArray(c) && (c.header || c.query || c.body) ? c : undefined;
  return { apiKey: target(config.apiKey), model: target(config.models), effort: target(config.effort) };
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
  });
  const config = settingsConfig(options.settings);
  const targets = settingTargets(options.settings);
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

  /** Save the current conversation, a snapshot is sent so stores never hold live objects */
  async function persist() {
    if (!history || !state.messages.length) return;
    const messages = structuredClone(unwrap(state.messages));
    try {
      await history.save({
        id: state.conversationId,
        title: titleOf(messages),
        messages,
        createdAt: messages[0].createdAt,
        updatedAt: new Date(),
      });
      await refreshList();
    } catch (err) {
      fail(err);
    }
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
    const ctx = { messages, settings: { ...settings }, targets, signal: ctrl.signal, threadId };
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
      // Tools without result (client-side or interrupted) are considered done when the stream ends
      setState(
        "messages",
        i,
        produce((m) => {
          for (const p of m.parts) if (p.type === "tool") p.status = "done";
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

  const stop = () => controller?.abort();

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
    setSetting,
    newConversation,
    openConversation,
    deleteConversation,
  };
}
