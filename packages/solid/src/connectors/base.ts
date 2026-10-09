import type {
  ChatEvent,
  ChatRequest,
  ChatSettings,
  FilePart,
  McpRequest,
  Message,
  SettingAppliers,
  ToolPart,
} from "../types.ts";

/** What a request needs from the chat */
export interface RequestContext {
  /** Values chosen by the user in the toolbar */
  settings: ChatSettings;
  /** Setting callbacks defined in the chat options, they replace the connector defaults */
  apply?: SettingAppliers;
  signal?: AbortSignal;
  threadId: string;
}

export interface ConnectorContext extends RequestContext {
  /** Conversation history, including the new user message */
  messages: Message[];
  signal: AbortSignal;
}

/** Streams the assistant response for a conversation, as normalized chat events */
export interface Connector {
  stream(ctx: ConnectorContext): AsyncIterable<ChatEvent>;
  /** Send an MCP request of a widget (MCP Apps / MCP-UI) to its server, returns the MCP result */
  mcpRequest?(request: McpRequest, ctx: RequestContext): Promise<unknown>;
}

export interface HttpConnectorOptions {
  url: string;
  /** Extra request headers, e.g. Authorization */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Extra fields merged into the request body, copied for each request */
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

/**
 * Base for connectors that POST JSON and read a Server-Sent Events response.
 * Subclasses define the request `body()` and how to `parse()` the stream.
 * Settings values are added to the request by their `apply` callback.
 */
export abstract class HttpConnector implements Connector {
  protected options: HttpConnectorOptions;

  /** Default callback of each setting, replaced by callbacks defined in the chat options */
  protected applySettings: SettingAppliers = {
    apiKey: (req, key) => (req.headers.Authorization = `Bearer ${key}`),
    model: (req, model) => (req.body.model = model),
    effort: (req, effort) => (req.body.reasoning_effort = effort),
  };

  constructor(options: HttpConnectorOptions) {
    this.options = options;
  }

  /** JSON body sent to the endpoint */
  protected abstract body(ctx: ConnectorContext): Record<string, unknown>;

  /** Convert the SSE `data` payloads to chat events */
  protected abstract parse(data: AsyncIterable<string>, ctx: ConnectorContext): AsyncIterable<ChatEvent>;

  /** Request headers */
  protected async headers(_ctx: RequestContext): Promise<Record<string, string>> {
    const { headers } = this.options;
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(typeof headers === "function" ? await headers() : headers),
    };
  }

  async *stream(ctx: ConnectorContext): AsyncGenerator<ChatEvent> {
    yield* this.parse(this.post(this.body(ctx), ctx), ctx);
  }

  /** POST a body to the endpoint, with the headers and settings, yields the SSE `data` payloads of the response */
  protected async *post(body: Record<string, unknown>, ctx: RequestContext): AsyncGenerator<string> {
    // Relative URLs resolve against the page
    const req: ChatRequest = {
      url: new URL(this.options.url, globalThis.location?.href),
      headers: await this.headers(ctx),
      body,
    };
    // Each setting value is added by its callback from the chat options, or the connector default
    for (const [key, value] of Object.entries(ctx.settings) as [keyof ChatSettings, string | undefined][]) {
      const apply = ctx.apply?.[key] ?? this.applySettings[key];
      if (value && apply) apply(req, value);
    }

    const res = await fetch(String(req.url), {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctx.signal,
    });
    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`${res.status} ${res.statusText} ${detail}`.trim());
    }
    yield* sse(res);
  }
}
