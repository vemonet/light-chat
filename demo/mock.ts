import weatherApp from "./weather-app.html?raw";

// Scripted answer streamed by the mock endpoints, same content for both protocols.
// Stages, sub-agents, activities and tool UIs are AG-UI only, the OpenAI stream flattens or skips them
type Step =
  | { reasoning: string }
  | { text: string }
  /** `ui` is the resource URI of an MCP App showing the result */
  | { tool: string; args: object; result: object; ui?: string }
  | { stage: string; steps: Step[] }
  | { agent: string; description: string; steps: Step[] }
  | { activity: string; content?: object; patch?: object[] };

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

/** Multi-agent answer, sent when the question mentions agents */
const agentsScript = (question: string, received: string): Step[] => [
  { reasoning: `The user asked: "${question}". Received ${received}. I will plan, then delegate to sub-agents.` },
  {
    stage: "plan_trip",
    steps: [
      {
        activity: "PLAN",
        content: {
          title: "Plan",
          tasks: [
            { task: "Check the weather", status: "pending" },
            { task: "Write the summary", status: "pending" },
          ],
        },
      },
    ],
  },
  {
    agent: "weather_researcher",
    description: "Looks up current conditions",
    steps: [
      { reasoning: "I need the current weather in Lausanne." },
      {
        tool: "get_weather",
        args: { city: "Lausanne", unit: "celsius" },
        result: { temperature: 18, condition: "Partly cloudy" },
      },
      { text: "Lausanne is at **18 C** and partly cloudy." },
    ],
  },
  { activity: "PLAN", patch: [{ op: "replace", path: "/tasks/0/status", value: "done" }] },
  {
    agent: "writer",
    description: "Turns the findings into a short answer",
    steps: [{ text: "Drafted a two line summary for the user." }],
  },
  { activity: "PLAN", patch: [{ op: "replace", path: "/tasks/1/status", value: "done" }] },
  { text: "Two sub-agents worked on this: it is **18 C** and *partly cloudy* in Lausanne, a good day for a walk." },
];

const WEATHER_UI = "ui://weather/app.html";
const conditions = ["Sunny", "Partly cloudy", "Light rain", "Windy"];
const weather = () => ({
  temperature: 12 + Math.floor(Math.random() * 10),
  condition: conditions[Math.floor(Math.random() * conditions.length)],
});

/** Answer with an MCP App widget, sent when the question mentions a widget */
const widgetScript = (question: string, received: string): Step[] => [
  { reasoning: `The user asked: "${question}". Received ${received}. The weather tool has an interactive UI.` },
  { tool: "get_weather", args: { city: "Lausanne" }, result: weather(), ui: WEATHER_UI },
  { text: "Here is a live weather widget: **Refresh** calls the tool again, the other button asks me a question." },
];

/** Result of an MCP request sent by a widget (`forwardedProps.__proxiedMCPRequest`) */
function mcpResult(request: { method: string; params?: any }) {
  if (request.method === "resources/read" && request.params?.uri === WEATHER_UI)
    return { contents: [{ uri: WEATHER_UI, mimeType: "text/html;profile=mcp-app", text: weatherApp }] };
  if (request.method === "tools/list")
    return { tools: [{ name: "get_weather", _meta: { ui: { resourceUri: WEATHER_UI } } }] };
  if (request.method === "tools/call" && request.params?.name === "get_weather") {
    const w = weather();
    return { content: [{ type: "text", text: JSON.stringify(w) }], structuredContent: w };
  }
  return { error: `Unknown MCP request ${request.method}` };
}

const chunks = (s: string) => s.match(/[\s\S]{1,4}/g) ?? [];

/** Convert the script to protocol specific SSE payloads */
/** Steps without stages, sub-agents and activities, which OpenAI streams have no equivalent for */
const flatten = (steps: Step[]): Step[] =>
  steps.flatMap((s) => ("steps" in s ? flatten(s.steps) : "activity" in s ? [] : [s]));

function* openaiEvents(steps: Step[]) {
  const delta = (d: object) => ({ choices: [{ index: 0, delta: d }] });
  let index = 0;
  for (const step of flatten(steps)) {
    if ("reasoning" in step) for (const c of chunks(step.reasoning)) yield delta({ reasoning_content: c });
    else if ("text" in step) for (const c of chunks(step.text)) yield delta({ content: c });
    else if ("tool" in step) {
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
  // Events of a sub-agent carry its run id
  function* run(steps: Step[], subagentRunId?: string): Generator<object> {
    const tag = subagentRunId ? { subagentRunId } : {};
    for (const step of steps) {
      const id = `m${n++}`;
      if ("reasoning" in step) {
        yield { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning", ...tag };
        for (const c of chunks(step.reasoning))
          yield { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: c, ...tag };
        yield { type: "REASONING_MESSAGE_END", messageId: id, ...tag };
      } else if ("text" in step) {
        yield { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant", ...tag };
        for (const c of chunks(step.text)) yield { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: c, ...tag };
        yield { type: "TEXT_MESSAGE_END", messageId: id, ...tag };
      } else if ("tool" in step) {
        yield { type: "TOOL_CALL_START", toolCallId: id, toolCallName: step.tool, ...tag };
        for (const c of chunks(JSON.stringify(step.args)))
          yield { type: "TOOL_CALL_ARGS", toolCallId: id, delta: c, ...tag };
        yield { type: "TOOL_CALL_END", toolCallId: id, ...tag };
        yield {
          type: "TOOL_CALL_RESULT",
          messageId: `r${id}`,
          toolCallId: id,
          content: JSON.stringify(step.result),
          role: "tool",
          ...tag,
        };
        // Raw tool result for the chat, like the light-chat server
        if (step.ui)
          yield {
            type: "ACTIVITY_SNAPSHOT",
            messageId: `ui${id}`,
            activityType: "mcp-apps",
            content: {
              result: {
                content: [{ type: "text", text: JSON.stringify(step.result) }],
                structuredContent: step.result,
              },
              serverId: "demo",
              tool: { name: step.tool, _meta: { ui: { resourceUri: step.ui } } },
              toolInput: step.args,
            },
            ...tag,
          };
      } else if ("stage" in step) {
        yield { type: "STEP_STARTED", stepName: step.stage, ...tag };
        yield* run(step.steps, subagentRunId);
        yield { type: "STEP_FINISHED", stepName: step.stage, ...tag };
      } else if ("agent" in step) {
        const { agent: name, description } = step;
        yield { type: "SUBAGENT_STARTED", subagentRunId: id, parentSubagentRunId: subagentRunId, name, description };
        yield* run(step.steps, id);
        yield { type: "SUBAGENT_FINISHED", subagentRunId: id };
      } else if (step.patch) {
        // Activities are identified by their type in this mock
        yield {
          type: "ACTIVITY_DELTA",
          messageId: step.activity,
          activityType: step.activity,
          patch: step.patch,
          ...tag,
        };
      } else {
        yield {
          type: "ACTIVITY_SNAPSHOT",
          messageId: step.activity,
          activityType: step.activity,
          content: step.content,
          ...tag,
        };
      }
    }
  }
  yield* run(steps);
  yield { type: "RUN_FINISHED", threadId: "t", runId: "r" };
}

/** Answer a mock request with the scripted SSE stream, in the given protocol */
async function respond(protocol: "openai" | "agui", req: Request, delay: number): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const proxied = protocol === "agui" && body.forwardedProps?.__proxiedMCPRequest;
  if (proxied) {
    const run = { threadId: body.threadId, runId: body.runId };
    const result = mcpResult(proxied);
    const sse = [
      { type: "RUN_STARTED", ...run },
      { type: "RUN_FINISHED", ...run, result },
    ];
    const text = sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
  }
  // Content is a string, or an array of parts when files are attached
  const content = body.messages?.at(-1)?.content ?? "";
  const parts: any[] = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const last = parts.find((p) => p.type === "text")?.text ?? "";
  const settings = protocol === "openai" ? body : body.forwardedProps;
  const query = new URL(req.url).searchParams;
  const received = [
    `model ${settings?.model ?? "none"}`,
    `effort ${settings?.reasoning_effort ?? settings?.effort ?? query.get("effort") ?? "none"}`,
    `API key ${req.headers.get("authorization") ? "yes" : "no"}`,
    `${parts.length - (last ? 1 : 0)} file(s)`,
  ].join(", ");
  const steps = (/agent/i.test(last) ? agentsScript : /widget/i.test(last) ? widgetScript : script)(last, received);
  const events = protocol === "openai" ? openaiEvents(steps) : aguiEvents(steps);
  const encoder = new TextEncoder();
  // One event per pull, spaced out to look like a model streaming. Stops when the request is aborted
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, delay));
      const { value, done } = events.next();
      if (done || req.signal.aborted) return c.close();
      c.enqueue(encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`));
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Patch `fetch` so POST requests to `/api/openai` and `/api/agui` (same origin) stream a scripted answer.
 * Runs in the browser, so the demo works as a static site. Other requests go to the network.
 */
export function installMockBackend({ delay = 12 } = {}) {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const protocol = url.pathname.match(/\/api\/(openai|agui)$/)?.[1] as "openai" | "agui" | undefined;
    if (!protocol || url.origin !== location.origin) return realFetch(input, init);
    return respond(protocol, new Request(input, init), delay);
  };
}
