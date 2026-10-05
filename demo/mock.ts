import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite-plus";

// Scripted answer streamed by the mock endpoints, same content for both protocols
type Step = { reasoning: string } | { text: string } | { tool: string; args: object; result: object };

const script = (question: string, received: string): Step[] => [
  {
    reasoning: `The user asked: "${question}". Received ${received}. I should check the weather tool before answering, then show some formatting.`,
  },
  { text: "Let me look that up for you." },
  {
    tool: "get_weather",
    args: { city: "Lausanne", unit: "celsius" },
    result: { temperature: 18, condition: "Partly cloudy", wind_kmh: 12 },
  },
  {
    text: `## Weather in Lausanne

It is currently **18 C** and *partly cloudy*, with a light breeze.

| Day | Min | Max |
| --- | --- | --- |
| Today | 11 | 18 |
| Tomorrow | 9 | 16 |

A quick snippet to fetch it yourself:

\`\`\`python
import httpx

def weather(city: str) -> dict:
    """Fetch the current weather"""
    r = httpx.get("https://wttr.in/" + city, params={"format": "j1"})
    return r.json()["current_condition"][0]
\`\`\`

Use \`weather("Lausanne")\` and see the [docs](https://wttr.in/:help) for more options.`,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunks = (s: string) => s.match(/[\s\S]{1,4}/g) ?? [];

async function readBody(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

/** Convert the script to protocol specific SSE payloads */
function* openaiEvents(steps: Step[]) {
  const delta = (d: object) => ({ choices: [{ index: 0, delta: d }] });
  let index = 0;
  for (const step of steps) {
    if ("reasoning" in step) for (const c of chunks(step.reasoning)) yield delta({ reasoning_content: c });
    else if ("text" in step) for (const c of chunks(step.text)) yield delta({ content: c });
    else {
      const i = index++;
      yield delta({
        tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: step.tool, arguments: "" } }],
      });
      for (const c of chunks(JSON.stringify(step.args)))
        yield delta({ tool_calls: [{ index: i, function: { arguments: c } }] });
    }
  }
  yield "[DONE]";
}

function* aguiEvents(steps: Step[]) {
  yield { type: "RUN_STARTED", threadId: "t", runId: "r" };
  let n = 0;
  for (const step of steps) {
    const id = `m${n++}`;
    if ("reasoning" in step) {
      yield { type: "REASONING_MESSAGE_START", messageId: id, role: "assistant" };
      for (const c of chunks(step.reasoning)) yield { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: c };
      yield { type: "REASONING_MESSAGE_END", messageId: id };
    } else if ("text" in step) {
      yield { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" };
      for (const c of chunks(step.text)) yield { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: c };
      yield { type: "TEXT_MESSAGE_END", messageId: id };
    } else {
      yield { type: "TOOL_CALL_START", toolCallId: id, toolCallName: step.tool };
      for (const c of chunks(JSON.stringify(step.args))) yield { type: "TOOL_CALL_ARGS", toolCallId: id, delta: c };
      yield { type: "TOOL_CALL_END", toolCallId: id };
      yield {
        type: "TOOL_CALL_RESULT",
        messageId: `r${id}`,
        toolCallId: id,
        content: JSON.stringify(step.result),
        role: "tool",
      };
    }
  }
  yield { type: "RUN_FINISHED", threadId: "t", runId: "r" };
}

/** Vite plugin exposing POST /api/openai and /api/agui mock streaming endpoints */
export function mockBackend(): Plugin {
  const handler = (protocol: "openai" | "agui") => async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    // Content is a string, or an array of parts when files are attached
    const content = body.messages?.at(-1)?.content ?? "";
    const parts: any[] = Array.isArray(content) ? content : [{ type: "text", text: content }];
    const last = parts.find((p) => p.type === "text")?.text ?? "";
    const settings = protocol === "openai" ? body : body.forwardedProps;
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const received = [
      `model ${settings?.model ?? "none"}`,
      `effort ${settings?.reasoning_effort ?? settings?.effort ?? query.get("effort") ?? "none"}`,
      `API key ${req.headers.authorization ? "yes" : "no"}`,
      `${parts.length - (last ? 1 : 0)} file(s)`,
    ].join(", ");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const events = protocol === "openai" ? openaiEvents(script(last, received)) : aguiEvents(script(last, received));
    let closed = false;
    req.on("close", () => (closed = true));
    for (const e of events) {
      if (closed) return;
      res.write(`data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`);
      await sleep(12);
    }
    res.end();
  };
  return {
    name: "light-chat-mock",
    configureServer(server) {
      server.middlewares.use("/api/openai", handler("openai"));
      server.middlewares.use("/api/agui", handler("agui"));
    },
  };
}
