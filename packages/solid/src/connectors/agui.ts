import type { ActivityPart, ChatEvent, ChatRequest, FilePart, McpRequest, Message } from "../types.ts";
import { applyPatch, uid } from "../utils.ts";
import {
  HttpConnector,
  toTurns,
  type ConnectorContext,
  type HttpConnectorOptions,
  type RequestContext,
  type Turn,
} from "./base.ts";

/** Files as typed multimodal content parts, with raw base64 data */
const fileContent = (f: FilePart) => {
  const kind = f.mimeType.split("/")[0];
  return {
    type: ["image", "audio", "video"].includes(kind) ? kind : "document",
    source: { type: "data", value: f.data.slice(f.data.indexOf(",") + 1), mimeType: f.mimeType },
    metadata: { filename: f.name },
  };
};

function toMessage(t: Turn) {
  switch (t.role) {
    case "user":
      return {
        id: t.id,
        role: "user",
        content: t.files.length
          ? [...(t.text ? [{ type: "text", text: t.text }] : []), ...t.files.map(fileContent)]
          : t.text,
      };
    case "assistant":
      return {
        id: uid(),
        role: "assistant",
        content: t.text,
        ...(t.toolCalls.length && {
          toolCalls: t.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args || "{}" },
          })),
        }),
      };
    case "tool":
      return { id: uid(), role: "tool", toolCallId: t.toolCallId, content: t.content };
  }
}

/** Context set by widgets for the model (MCP Apps `ui/update-model-context`), as AG-UI context entries */
const widgetContext = (messages: Message[]) =>
  messages
    .flatMap((m) => m.parts)
    .filter((p): p is ActivityPart => p.type === "activity" && p.context !== undefined)
    .map((p) => ({
      description: `Current state of the interactive UI ${(p.content as { resourceUri?: string })?.resourceUri ?? p.id}, updated by the user`,
      value: JSON.stringify(p.context),
    }));

/** Raw AG-UI event, as received from the agent */
export type AgUiEvent = { type: string; [key: string]: any };

export interface AgUiConnectorOptions extends HttpConnectorOptions {
  /** Called with every raw event, e.g. to handle `CUSTOM` events or interrupts in `RUN_FINISHED` */
  onEvent?: (event: AgUiEvent) => void;
}

/** AG-UI protocol (https://docs.ag-ui.com) */
export class AgUiConnector extends HttpConnector {
  private onEvent?: AgUiConnectorOptions["onEvent"];

  constructor(options: AgUiConnectorOptions) {
    super(options);
    this.onEvent = options.onEvent;
    // AG-UI has no standard field for the model and effort, they are forwarded to the agent
    const forward = (key: string) => (req: ChatRequest, value: string) =>
      (req.body.forwardedProps = { ...(req.body.forwardedProps as object), [key]: value });
    this.applySettings = { ...this.applySettings, model: forward("model"), effort: forward("effort") };
  }

  protected body(ctx: ConnectorContext) {
    return {
      threadId: ctx.threadId,
      runId: uid(),
      messages: toTurns(ctx.messages).map(toMessage),
      tools: [],
      context: widgetContext(ctx.messages),
      // Shared state returned by the previous run
      state: ctx.messages.findLast((m) => m.state !== undefined)?.state ?? {},
      forwardedProps: {},
      ...structuredClone(this.options.body),
    };
  }

  /**
   * MCP request of a widget, proxied by the agent like the AG-UI MCP Apps middleware:
   * sent in `forwardedProps.__proxiedMCPRequest`, the MCP result is the `RUN_FINISHED` result.
   */
  async mcpRequest(request: McpRequest, ctx: RequestContext): Promise<unknown> {
    const body = this.body({ ...ctx, messages: [], signal: ctx.signal ?? new AbortController().signal });
    body.state = {};
    body.forwardedProps = { ...(body.forwardedProps as object), __proxiedMCPRequest: request };
    for await (const payload of this.post(body, ctx)) {
      const e: AgUiEvent = JSON.parse(payload);
      if (e.type === "RUN_ERROR") throw new Error(e.message ?? "MCP request failed");
      if (e.type !== "RUN_FINISHED") continue;
      if (typeof e.result?.error === "string") throw new Error(e.result.error);
      return e.result;
    }
    throw new Error("No result for the MCP request");
  }

  protected async *parse(data: AsyncIterable<string>, ctx: ConnectorContext): AsyncGenerator<ChatEvent> {
    let lastTool = "";
    let state = ctx.messages.findLast((m) => m.state !== undefined)?.state ?? {};
    // Activity contents by message id, deltas are patches on them
    const activities = new Map<string, unknown>();

    /** Chat events for one AG-UI event */
    function* convert(e: AgUiEvent): Generator<ChatEvent> {
      switch (e.type) {
        case "TEXT_MESSAGE_CONTENT":
        case "TEXT_MESSAGE_CHUNK":
          if (e.delta) yield { type: "text", delta: e.delta };
          break;
        case "REASONING_MESSAGE_CONTENT":
        case "REASONING_MESSAGE_CHUNK":
        case "THINKING_TEXT_MESSAGE_CONTENT":
          if (e.delta) yield { type: "reasoning", delta: e.delta };
          break;
        case "TOOL_CALL_START":
          lastTool = e.toolCallId;
          yield { type: "tool-start", id: e.toolCallId, name: e.toolCallName };
          break;
        case "TOOL_CALL_ARGS":
          yield { type: "tool-args", id: e.toolCallId, delta: e.delta };
          break;
        case "TOOL_CALL_CHUNK":
          // First chunk carries id and name, following ones only the args delta
          if (e.toolCallName && e.toolCallId !== lastTool) {
            lastTool = e.toolCallId ?? `call_${uid()}`;
            yield { type: "tool-start", id: lastTool, name: e.toolCallName };
          }
          if (e.delta) yield { type: "tool-args", id: e.toolCallId ?? lastTool, delta: e.delta };
          break;
        case "TOOL_CALL_RESULT":
          yield { type: "tool-result", id: e.toolCallId, result: e.content };
          break;
        case "STEP_STARTED":
          yield { type: "step-start", name: e.stepName };
          break;
        case "STEP_FINISHED":
          yield { type: "step-end", name: e.stepName };
          break;
        case "SUBAGENT_STARTED":
          yield { type: "subagent-start", id: e.subagentRunId, name: e.name, description: e.description };
          break;
        case "SUBAGENT_FINISHED":
          yield { type: "subagent-end", id: e.subagentRunId, result: e.result };
          break;
        case "SUBAGENT_ERROR":
          yield { type: "subagent-end", id: e.subagentRunId, error: e.message ?? "Sub-agent failed" };
          break;
        case "ACTIVITY_SNAPSHOT":
        case "ACTIVITY_DELTA": {
          // A snapshot without replace only creates the activity
          if (e.type === "ACTIVITY_SNAPSHOT" && e.replace === false && activities.has(e.messageId)) break;
          const content =
            e.type === "ACTIVITY_SNAPSHOT" ? e.content : applyPatch(activities.get(e.messageId) ?? {}, e.patch);
          activities.set(e.messageId, content);
          yield { type: "activity", id: e.messageId, activityType: e.activityType, content };
          break;
        }
        case "STATE_SNAPSHOT":
        case "STATE_DELTA":
          // Only the main agent state is sent back to the agent
          if (e.subagentRunId) break;
          state = e.type === "STATE_SNAPSHOT" ? e.snapshot : applyPatch(state, e.delta);
          yield { type: "state", state };
          break;
        case "RUN_ERROR":
          yield { type: "error", message: e.message ?? "Run failed" };
          break;
      }
    }

    for await (const payload of data) {
      const e: AgUiEvent = JSON.parse(payload);
      this.onEvent?.(e);
      // Sub-agent lifecycle events belong to their parent, other events to the sub-agent they come from
      const owner: string | undefined = e.type.startsWith("SUBAGENT_") ? e.parentSubagentRunId : e.subagentRunId;
      for (const out of convert(e)) yield owner ? { ...out, subagent: owner } : out;
    }
  }
}
