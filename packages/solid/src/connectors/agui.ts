import type { ChatEvent, FilePart } from "../types.ts";
import { uid } from "../utils.ts";
import { HttpConnector, toTurns, type ConnectorContext, type HttpConnectorOptions, type Turn } from "./base.ts";

/** Files as binary content parts, with raw base64 data */
const fileContent = (f: FilePart) => ({
  type: "binary",
  mimeType: f.mimeType,
  filename: f.name,
  data: f.data.slice(f.data.indexOf(",") + 1),
});

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

/** AG-UI protocol (https://docs.ag-ui.com) */
export class AgUiConnector extends HttpConnector {
  constructor(options: HttpConnectorOptions) {
    super(options);
    // AG-UI has no standard field for the model and effort, they are forwarded to the agent
    this.settingTargets = {
      ...this.settingTargets,
      model: { body: "forwardedProps.model" },
      effort: { body: "forwardedProps.effort" },
    };
  }

  protected body(ctx: ConnectorContext) {
    return {
      threadId: ctx.threadId,
      runId: uid(),
      messages: toTurns(ctx.messages).map(toMessage),
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
      ...this.options.body,
    };
  }

  protected async *parse(data: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
    let lastTool = "";
    for await (const payload of data) {
      const e = JSON.parse(payload);
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
        case "RUN_ERROR":
          yield { type: "error", message: e.message ?? "Run failed" };
          break;
      }
    }
  }
}
