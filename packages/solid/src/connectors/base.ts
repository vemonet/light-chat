import type { ChatEvent, ChatSettings, FilePart, Message, SettingTargets, ToolPart } from "../types.ts";

export interface ConnectorContext {
  /** Conversation history, including the new user message */
  messages: Message[];
  /** Values chosen by the user in the settings menu */
  settings: ChatSettings;
  /** Targets defined in the chat options, they replace the connector defaults */
  targets?: SettingTargets;
  signal: AbortSignal;
  threadId: string;
}

/** Streams the assistant response for a conversation, as normalized chat events */
export interface Connector {
  stream(ctx: ConnectorContext): AsyncIterable<ChatEvent>;
}

export interface HttpConnectorOptions {
  url: string;
  /** Extra request headers, e.g. Authorization */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Extra fields merged into the request body */
  body?: Record<string, unknown>;
}

/** Protocol agnostic conversation turn, mapped to the wire format by each connector */
export type Turn =
  | { role: "user"; id: string; text: string; files: FilePart[] }
  | { role: "assistant"; text: string; toolCalls: ToolPart[] }
  | { role: "tool"; toolCallId: string; content: string };

/**
 * Flatten UI messages to turns.
 * An assistant message is split in several turns when text follows tool calls.
 * Tool calls without result are dropped, since backends reject unanswered calls.
 */
export function toTurns(messages: Message[]): Turn[] {
  const out: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      out.push({ role: "user", id: m.id, text, files: m.parts.filter((p): p is FilePart => p.type === "file") });
      continue;
    }
    let text = "";
    let toolCalls: ToolPart[] = [];
    const flush = () => {
      if (!text && !toolCalls.length) return;
      out.push({ role: "assistant", text, toolCalls });
      for (const t of toolCalls) out.push({ role: "tool", toolCallId: t.id, content: t.result! });
      text = "";
      toolCalls = [];
    };
    for (const p of m.parts) {
      if (p.type === "text") {
        if (toolCalls.length) flush();
        text += p.text;
      } else if (p.type === "tool" && p.result !== undefined) {
        toolCalls.push(p);
      }
    }
    flush();
  }
  return out;
}

/** Parse a Server-Sent Events response, yields the `data` payload of each event */
export async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const dataOf = (event: string) =>
    event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const events = buf.split(/\r?\n\r?\n/);
    buf = events.pop()!;
    for (const event of events) {
      const data = dataOf(event);
      if (data) yield data;
    }
  }
  const data = dataOf(buf);
  if (data) yield data;
}

/** Set a value at a dotted path in an object, creating nested objects as needed */
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  const last = keys.pop()!;
  let cur = obj;
  for (const k of keys) {
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[last] = value;
}

/**
 * Base for connectors that POST JSON and read a Server-Sent Events response.
 * Subclasses define the request `body()` and how to `parse()` the stream.
 * Settings values are added to the request according to their targets.
 */
export abstract class HttpConnector implements Connector {
  protected options: HttpConnectorOptions;

  /** Default target of each setting, replaced by targets defined in the chat options */
  protected settingTargets: SettingTargets = {
    apiKey: { header: "Authorization", prefix: "Bearer " },
    model: { body: "model" },
    effort: { body: "reasoning_effort" },
  };

  constructor(options: HttpConnectorOptions) {
    this.options = options;
  }

  /** JSON body sent to the endpoint */
  protected abstract body(ctx: ConnectorContext): Record<string, unknown>;

  /** Convert the SSE `data` payloads to chat events */
  protected abstract parse(data: AsyncIterable<string>): AsyncIterable<ChatEvent>;

  /** Request headers */
  protected async headers(_ctx: ConnectorContext): Promise<Record<string, string>> {
    const { headers } = this.options;
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(typeof headers === "function" ? await headers() : headers),
    };
  }

  async *stream(ctx: ConnectorContext): AsyncGenerator<ChatEvent> {
    const headers = await this.headers(ctx);
    const body = this.body(ctx);
    const query = new URLSearchParams();
    // Put each setting value in the header, query parameter and/or body key of its target
    for (const [key, value] of Object.entries(ctx.settings) as [keyof ChatSettings, string | undefined][]) {
      const target = ctx.targets?.[key] ?? this.settingTargets[key];
      if (!value || !target) continue;
      const v = (target.prefix ?? "") + value;
      if (target.header) headers[target.header] = v;
      if (target.query) query.set(target.query, v);
      if (target.body) setPath(body, target.body, v);
    }
    let url = this.options.url;
    if (query.size) url += (url.includes("?") ? "&" : "?") + query.toString();

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`${res.status} ${res.statusText} ${detail}`.trim());
    }
    yield* this.parse(sse(res));
  }
}
