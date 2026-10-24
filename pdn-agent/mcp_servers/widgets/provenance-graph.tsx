// Graph of the tool calls of an answer, from the question to the answer, step by step
import { createSignal, For, Show } from "solid-js";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface Call {
  id: string;
  name: string;
  server: string | null;
  /** Model response that made the call, calls of one step run in parallel */
  step: number;
  args: unknown;
  /** `running`, `ok` or `error` (the model was asked to retry) */
  status: string;
  /** Numbers and lengths of non-empty lists at the top level of a JSON result */
  counts: Record<string, number>;
  urls: string[];
  chars: number;
  preview: string;
}

/** `structuredContent` of the graph, built from the events of the agent run */
interface Graph {
  question: string | null;
  model: string;
  calls: Call[];
}

// Colors of the MCP servers, by order of appearance
const PALETTE = ["#0969da", "#8250df", "#1a7f37", "#bf8700", "#cf222e", "#1b7c83", "#bc4c00", "#6e7781", "#d63384"];
const STATUS: Record<string, string> = { ok: "ok", error: "retried", running: "no result" };

const serverOf = (c: Call) => c.server ?? "unknown server";
const short = (v: unknown, n = 40) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
};
const kchars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toPrecision(3));

export default function Widget() {
  const mcp = createMcpApp<Graph>("Provenance graph");
  return (
    <Show
      when={mcp.data()}
      keyed
      fallback={
        <header>
          <h1>Provenance graph</h1>
        </header>
      }
    >
      {(data) => <ProvenanceGraph data={data} mcp={mcp} />}
    </Show>
  );
}

function ProvenanceGraph(props: { data: Graph; mcp: McpApp<Graph> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const calls = data.calls;
  const servers = [...new Set(calls.map(serverOf))];
  const colors = Object.fromEntries(servers.map((s, i) => [s, PALETTE[i % PALETTE.length]]));
  const errors = calls.filter((c) => c.status === "error").length;
  // Calls grouped by step, in step order
  const byStep: Record<number, Call[]> = {};
  for (const c of calls) (byStep[c.step] ??= []).push(c);
  const steps = Object.values(byStep);

  // IDs of the expanded cards
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set());
  const allOpen = () => open().size === calls.length;
  const expand = (id: string) => !open().has(id) && setOpen(new Set([...open(), id]));
  const collapse = (id: string) => setOpen(new Set([...open()].filter((x) => x !== id)));

  /** Server, name, arguments and counts of a call, its full arguments and result once expanded */
  function Card(p: { call: Call }) {
    const c = p.call;
    const isOpen = () => open().has(c.id);
    const args = typeof c.args === "object" && c.args ? Object.entries(c.args) : [];
    const counts = Object.entries(c.counts);
    const countChips = (list: [string, number][]) => (
      <For each={list}>
        {([k, v]) => (
          <span class="chip count">
            {k}: {fmt(v)}
          </span>
        )}
      </For>
    );
    return (
      <div
        class="card"
        classList={{ open: isOpen(), failed: c.status === "error" }}
        style={{ "--server": colors[serverOf(c)] }}
        onClick={() => expand(c.id)}
      >
        <div class="head">
          <span class="dot" />
          {serverOf(c)}
          <span class={`status ${c.status}`}>{STATUS[c.status] ?? c.status}</span>
        </div>
        <div class="name">{c.name}</div>
        <div class="chips">
          <For each={args.slice(0, isOpen() ? 0 : 3)}>
            {([k, v]) => (
              <span class="chip" title={short(v, 500)}>
                {k}={short(v, 28)}
              </span>
            )}
          </For>
          {countChips(counts.slice(0, 4))}
        </div>
        <div class="foot">
          {c.urls.length ? `${c.urls.length} URL${c.urls.length > 1 ? "s" : ""} · ` : ""}
          {kchars(c.chars)} chars returned
        </div>
        <Show when={isOpen()}>
          <div class="details">
            <h2>Arguments</h2>
            <pre>{typeof c.args === "string" ? c.args : JSON.stringify(c.args, null, 2)}</pre>
            <Show when={counts.length}>
              <h2>Counts</h2>
              <div class="chips">{countChips(counts)}</div>
            </Show>
            <Show when={c.urls.length}>
              <h2>URLs</h2>
              <div class="urls">
                <For each={c.urls}>{(u) => <a onClick={() => mcp.openLink(u)}>{u}</a>}</For>
              </div>
            </Show>
            <h2>
              Result{c.chars > c.preview.length ? ` (first ${c.preview.length} of ${kchars(c.chars)} chars)` : ""}
            </h2>
            <pre>{c.preview}</pre>
            <div class="actions">
              <button
                type="button"
                onClick={() =>
                  void mcp.sendMessage(
                    `Explain the result of the ${c.name} call (${c.server}) with arguments ${JSON.stringify(c.args)}`,
                  )
                }
              >
                Ask about this call
              </button>
              <button
                type="button"
                onClick={(e) => {
                  // The card would expand again
                  e.stopPropagation();
                  collapse(c.id);
                }}
              >
                Collapse
              </button>
            </div>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <>
      <header>
        <h1>Provenance graph</h1>
        <span class="muted">
          {calls.length} calls · {steps.length} steps · {servers.length} servers
          {errors ? ` · ${errors} retried` : ""}
        </span>
        <span class="spacer" />
        <button type="button" onClick={() => setOpen(allOpen() ? new Set<string>() : new Set(calls.map((c) => c.id)))}>
          {allOpen() ? "Collapse all" : "Expand all"}
        </button>
        <FullscreenButton mcp={mcp} />
      </header>
      <div class="legend">
        <For each={servers}>
          {(s) => (
            <span>
              <span class="dot" style={{ "--server": colors[s] }} />
              {s}
            </span>
          )}
        </For>
      </div>

      {/* Question, steps of parallel calls, answer, joined by arrows */}
      <div class="flow">
        <div class="end">
          <b>Question</b>
          {data.question ?? ""}
        </div>
        <For each={steps}>
          {(list, i) => (
            <>
              <div class="arrow" />
              <div class="step">
                <div class="step-label">
                  Step {i() + 1}
                  {list.length > 1 ? ` · ${list.length} calls in parallel` : ""}
                </div>
                <div class="cards">
                  <For each={list}>{(c) => <Card call={c} />}</For>
                </div>
              </div>
            </>
          )}
        </For>
        <div class="arrow" />
        <div class="end">
          <b>Answer</b>
          {data.model}
        </div>
      </div>
    </>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  .flow {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  :root[data-mode="fullscreen"] .flow {
    max-height: calc(100vh - 70px);
    overflow-y: auto;
  }
  /* Vertical arrow between the nodes of the flow */
  .arrow {
    position: relative;
    height: 22px;
  }
  .arrow::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 2px;
    bottom: 6px;
    border-left: 2px solid var(--border);
  }
  .arrow::after {
    content: "";
    position: absolute;
    left: calc(50% - 4px);
    bottom: 2px;
    border: 5px solid transparent;
    border-top-color: var(--border);
    border-bottom: 0;
  }
  .end {
    align-self: center;
    max-width: 90%;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--panel);
    text-align: center;
  }
  .end b {
    color: var(--muted);
    font-weight: 600;
    margin-right: 4px;
  }
  .step {
    border: 1px dashed var(--border);
    border-radius: 10px;
    padding: 6px 8px 8px;
  }
  .step-label {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .card {
    flex: 1 1 210px;
    min-width: 0;
    border: 1px solid var(--border);
    border-left: 4px solid var(--server);
    border-radius: 8px;
    padding: 6px 8px;
    background: var(--bg);
    cursor: pointer;
  }
  .card:hover {
    background: var(--hover);
  }
  .card.open {
    flex-basis: 100%;
    cursor: default;
    background: var(--bg);
  }
  .card.failed {
    border-color: #cf222e;
    border-left-color: var(--server);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--server);
  }
  .status {
    margin-left: auto;
    font-weight: 600;
  }
  .status.ok {
    color: #1a7f37;
  }
  .status.error {
    color: #cf222e;
  }
  :root[data-theme="dark"] .status.ok {
    color: #3fb950;
  }
  :root[data-theme="dark"] .status.error {
    color: #f85149;
  }
  .name {
    font: 600 12.5px var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    margin: 2px 0 4px;
    overflow-wrap: anywhere;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-size: 11px;
    padding: 0 6px;
    border-radius: 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.count {
    border-color: transparent;
    background: var(--hover);
  }
  .foot {
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }
  .details {
    margin-top: 8px;
    border-top: 1px solid var(--border);
    padding-top: 6px;
  }
  .details h2 {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    margin: 8px 0 3px;
  }
  .details h2:first-child {
    margin-top: 0;
  }
  pre {
    margin: 0;
    padding: 6px 8px;
    max-height: 220px;
    overflow: auto;
    background: var(--panel);
    border-radius: 6px;
    font: 11.5px/1.4 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .urls a {
    display: block;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .actions {
    margin-top: 8px;
    display: flex;
    gap: 6px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
`;
