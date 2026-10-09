import type { ChatEvent, FilePart } from "../types.ts";
import { uid } from "../utils.ts";
import { HttpConnector, toTurns, type ConnectorContext, type Turn } from "./base.ts";

/** Images as image_url, other files as file content parts */
const fileContent = (f: FilePart) =>
  f.mimeType.startsWith("image/")
    ? { type: "image_url", image_url: { url: f.data } }
    : { type: "file", file: { filename: f.name, file_data: f.data } };

function toMessage(t: Turn) {
  switch (t.role) {
    case "user":
      return {
        role: "user",
        content: t.files.length
          ? [...(t.text ? [{ type: "text", text: t.text }] : []), ...t.files.map(fileContent)]
          : t.text,
      };
    case "assistant":
      return {
        role: "assistant",
        content: t.text,
        ...(t.toolCalls.length && {
          tool_calls: t.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args || "{}" },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: t.toolCallId, content: t.content };
  }
}

/** OpenAI-compatible `/chat/completions` streaming */
export class OpenAIConnector extends HttpConnector {
  protected body(ctx: ConnectorContext) {
    return {
      ...structuredClone(this.options.body),
      stream: true,
      messages: toTurns(ctx.messages).map(toMessage),
    };
  }

  protected async *parse(data: AsyncIterable<string>): AsyncGenerator<ChatEvent> {
    // Tool calls are streamed by index, the id is only sent in the first chunk
    const ids: Record<number, string> = {};
    for await (const payload of data) {
      if (payload === "[DONE]") break;
      const chunk = JSON.parse(payload);
      if (chunk.error) yield { type: "error", message: chunk.error.message ?? String(chunk.error) };
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { type: "reasoning", delta: reasoning };
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        if (!ids[i] || (tc.id && tc.id !== ids[i])) {
          ids[i] = tc.id ?? `call_${uid()}`;
          yield { type: "tool-start", id: ids[i], name: tc.function?.name ?? "" };
        }
        if (tc.function?.arguments) yield { type: "tool-args", id: ids[i], delta: tc.function.arguments };
      }
    }
  }
}
