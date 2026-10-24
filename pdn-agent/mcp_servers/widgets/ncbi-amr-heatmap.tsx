// Heatmap of the AMR genes by organism in NCBI Pathogen Detection
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface HeatmapOrganism {
  name: string;
  isolates: number;
}

interface HeatmapGene {
  gene: string;
  /** Approximate isolates carrying the gene, per organism in the order of `organisms` */
  counts: number[];
}

/** `structuredContent` of the `show_amr_heatmap` tool */
interface HeatmapData {
  organisms: HeatmapOrganism[];
  genes: HeatmapGene[];
  filter: string | null;
  topN: number;
  totalGenes: number;
}

/** Selected cell, organism -1 for a whole gene row */
interface Selection {
  gene: HeatmapGene;
  org: number;
}

/** Content of the details box: a selection, or an organism with its most frequent genes */
type Details = Selection | { organism: number; top: string[] };

/** Cell under the pointer, with the pointer position in the window */
interface Hover {
  gene: HeatmapGene;
  org: number;
  x: number;
  y: number;
}

const pct = (x: number) =>
  x === 0 ? "0%" : x < 0.001 ? "<0.1%" : x < 0.1 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`;
const num = (n: number) => n.toLocaleString();
const total = (g: HeatmapGene) => g.counts.reduce((a, b) => a + b, 0);

export default function Widget() {
  const mcp = createMcpApp<HeatmapData>("AMR gene heatmap", "show_amr_heatmap");
  // A new tool result recreates the heatmap, which resets the options and selection
  return (
    <Show
      when={mcp.data()?.genes && mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading AMR genes" : "No AMR genes"}</h1>
        </header>
      }
    >
      {(data) => <Heatmap data={data} mcp={mcp} />}
    </Show>
  );
}

function Heatmap(props: { data: HeatmapData; mcp: McpApp<HeatmapData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const filter = data.filter ? `matching "${data.filter}" · ` : "";
  const loaded = data.totalGenes > data.genes.length ? ` (${data.genes.length} most prevalent loaded)` : "";
  const maxCount = Math.max(...data.genes.flatMap((x) => x.counts));
  const share = (g: HeatmapGene, o: number) =>
    data.organisms[o].isolates ? g.counts[o] / data.organisms[o].isolates : 0;
  const maxShare = (g: HeatmapGene) => Math.max(...g.counts.map((_, o) => share(g, o)));
  const across = (g: HeatmapGene) =>
    data.organisms.map((o, j) => `${o.name}: ${pct(share(g, j))} (${num(g.counts[j])})`).join(" · ");

  // Options of the toolbar
  const [mode, setMode] = createSignal<"share" | "count">("share");
  const [sort, setSort] = createSignal<"share" | "count" | "name">("share");
  const [text, setText] = createSignal("");
  const [top, setTop] = createSignal(String(data.topN));
  const [selected, setSelected] = createSignal<Selection>();
  const [details, setDetails] = createSignal<Details>();
  const [hover, setHover] = createSignal<Hover>();

  // Genes matching the filter, sorted, and the top N of them shown
  const matching = createMemo(() => {
    const needle = text().toLowerCase();
    const key = { share: maxShare, count: total, name: undefined }[sort()];
    return data.genes
      .filter((g) => !needle || g.gene.toLowerCase().includes(needle))
      .sort((a, b) => (key ? key(b) - key(a) : a.gene.localeCompare(b.gene)));
  });
  const genes = createMemo(() => matching().slice(0, Math.max(1, Number(top()) || 40)));

  /** Cell fill: share of isolates, or isolates on a log scale relative to the largest count */
  const intensity = (g: HeatmapGene, o: number) => {
    if (mode() === "share") return Math.sqrt(share(g, o));
    return g.counts[o] ? Math.log1p(g.counts[o]) / Math.log1p(maxCount) : 0;
  };

  /** Details of a cell, or of a gene across organisms, also told to the model */
  function select(gene: HeatmapGene, org: number) {
    setSelected({ gene, org });
    setDetails({ gene, org });
    if (org >= 0) {
      const o = data.organisms[org];
      void mcp.updateContext(
        `The user selected in the AMR heatmap: ${gene.gene} in ${o.name}: ${num(gene.counts[org])} of ` +
          `${num(o.isolates)} isolates (${pct(share(gene, org))}). Across organisms: ${across(gene)}`,
      );
    } else {
      void mcp.updateContext(`The user selected the gene ${gene.gene} in the AMR heatmap. ${across(gene)}`);
    }
  }

  /** Most frequent genes shown in an organism, also told to the model */
  function selectOrganism(org: number) {
    const top = genes()
      .filter((g) => g.counts[org])
      .sort((a, b) => b.counts[org] - a.counts[org])
      .slice(0, 10)
      .map((g) => `${g.gene} ${pct(share(g, org))}`);
    setDetails({ organism: org, top });
    void mcp.updateContext(
      `The user looked at ${data.organisms[org].name} in the AMR heatmap, most frequent genes: ${top.join(", ")}`,
    );
  }

  // Contents of the details box for each kind of selection
  function cellDetails(g: HeatmapGene, org: number) {
    const o = data.organisms[org];
    return (
      <>
        <div>
          <b>{g.gene}</b> in <b>{o.name}</b>: {num(g.counts[org])} of {num(o.isolates)} isolates ({pct(share(g, org))})
        </div>
        <div class="muted">{across(g)}</div>
        <div class="actions">
          <button
            type="button"
            onClick={() =>
              void mcp.sendMessage(
                `What is ${g.gene} and what does it mean that about ${pct(share(g, org))} of ${o.name} isolates ` +
                  `(${num(g.counts[org])}) carry it in NCBI Pathogen Detection?`,
              )
            }
          >
            Ask about it
          </button>
          <button
            type="button"
            onClick={() => void mcp.sendMessage(`Show the ${o.name} isolates carrying ${g.gene} in a table`)}
          >
            Show these isolates
          </button>
        </div>
      </>
    );
  }

  function geneDetails(g: HeatmapGene) {
    return (
      <>
        <div>
          <b>{g.gene}</b> across organisms
        </div>
        <div class="muted">{across(g)}</div>
        <div class="actions">
          <button
            type="button"
            onClick={() =>
              void mcp.sendMessage(`Why does the prevalence of ${g.gene} differ between these organisms: ${across(g)}?`)
            }
          >
            Compare across organisms
          </button>
        </div>
      </>
    );
  }

  function organismDetails(d: { organism: number; top: string[] }) {
    const o = data.organisms[d.organism];
    return (
      <>
        <div>
          <b>{o.name}</b> · {num(o.isolates)} isolates
        </div>
        <div class="muted">Most frequent: {d.top.join(", ") || "none"}</div>
      </>
    );
  }

  // Tooltip next to the pointer, kept in the window, placed once its content is rendered
  let tooltip!: HTMLDivElement;
  const [tipPosition, setTipPosition] = createSignal({ left: 0, top: 0 });
  createEffect(() => {
    const h = hover();
    if (!h) return;
    const { width, height } = tooltip.getBoundingClientRect();
    setTipPosition({
      left: Math.min(h.x + 12, innerWidth - width - 4),
      top: Math.min(h.y + 12, innerHeight - height - 4),
    });
  });

  return (
    <>
      <header>
        <h1>AMR genes in {data.organisms.length} organism groups</h1>
        <span class="muted" id="subtitle">
          {filter}
          {data.totalGenes} genes{loaded} · NCBI Pathogen Detection
        </span>
        <span class="spacer" />
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="toolbar">
        <select aria-label="Value shown" onChange={(e) => setMode(e.currentTarget.value as "share" | "count")}>
          <option value="share">Share of isolates</option>
          <option value="count">Number of isolates</option>
        </select>
        <select aria-label="Gene order" onChange={(e) => setSort(e.currentTarget.value as "share" | "count" | "name")}>
          <option value="share">Most prevalent</option>
          <option value="count">Most isolates</option>
          <option value="name">Gene name</option>
        </select>
        <input
          type="search"
          placeholder="Filter genes, e.g. KPC"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <label>
          Top <input type="number" min="1" value={top()} onChange={(e) => setTop(e.currentTarget.value)} />
        </label>
      </div>

      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="gene">
                {matching().length > genes().length
                  ? `${genes().length} of ${matching().length} genes`
                  : `${matching().length} genes`}
              </th>
              <For each={data.organisms}>
                {(o, j) => (
                  <th
                    classList={{ selected: selected()?.org === j() }}
                    title={o.name}
                    onClick={() => selectOrganism(j())}
                  >
                    {o.name}
                    <span class="muted">{num(o.isolates)} isolates</span>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody onMouseLeave={() => setHover()}>
            <For
              each={genes()}
              fallback={
                <tr>
                  <td class="gene muted">No gene matches the filter</td>
                </tr>
              }
            >
              {(g) => (
                <tr classList={{ selected: selected()?.gene === g && selected()!.org < 0 }}>
                  <td class="gene" title={g.gene} onClick={() => select(g, -1)} onMouseMove={() => setHover()}>
                    {g.gene}
                  </td>
                  <For each={data.organisms}>
                    {(_, o) => {
                      const v = () => intensity(g, o());
                      return (
                        <td
                          class="cell"
                          classList={{
                            dark: v() > 0.55,
                            zero: !g.counts[o()],
                            selected: selected()?.gene === g && selected()!.org === o(),
                          }}
                          style={
                            v()
                              ? {
                                  background: `color-mix(in srgb, var(--accent) ${Math.round(v() * 100)}%, transparent)`,
                                }
                              : undefined
                          }
                          onClick={() => select(g, o())}
                          onMouseMove={(e) => setHover({ gene: g, org: o(), x: e.clientX, y: e.clientY })}
                        >
                          {!g.counts[o()] ? "·" : mode() === "share" ? pct(share(g, o())) : num(g.counts[o()])}
                        </td>
                      );
                    }}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <div class="legend">
        <Show
          when={mode() === "share"}
          fallback={
            <>
              <span>0</span>
              <span class="ramp" />
              <span>{num(maxCount)} isolates (log scale)</span>
            </>
          }
        >
          <span>0%</span>
          <span class="ramp" />
          <span>100% of the isolates of the organism</span>
        </Show>
        <span>· approximate counts (index rows / 2)</span>
      </div>

      <div class="details" classList={{ muted: !details() }}>
        <Show when={details()} keyed fallback="Click a cell to ask about a gene in an organism">
          {(d) => ("gene" in d ? (d.org >= 0 ? cellDetails(d.gene, d.org) : geneDetails(d.gene)) : organismDetails(d))}
        </Show>
      </div>

      <div
        class="tooltip"
        ref={tooltip}
        hidden={!hover()}
        style={{ left: `${tipPosition().left}px`, top: `${tipPosition().top}px` }}
      >
        <Show when={hover()}>
          {(h) => (
            <>
              <b>{h().gene.gene}</b> · {data.organisms[h().org].name}
              <br />
              {num(h().gene.counts[h().org])} of {num(data.organisms[h().org].isolates)} isolates (
              {pct(share(h().gene, h().org))})
            </>
          )}
        </Show>
      </div>
    </>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-bottom: 8px;
  }
  .toolbar input[type="search"] {
    flex: 1;
    min-width: 120px;
  }
  .toolbar input[type="number"] {
    width: 64px;
  }
  .toolbar label {
    display: flex;
    gap: 4px;
    align-items: center;
    color: var(--muted);
    font-size: 12px;
  }
  .scroll {
    max-height: 470px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  :root[data-mode="fullscreen"] .scroll {
    max-height: calc(100vh - 200px);
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
    min-width: 100%;
  }
  th,
  td {
    padding: 0;
    background: var(--bg);
  }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    vertical-align: bottom;
    border-bottom: 1px solid var(--border);
    padding: 6px 6px 4px;
    font-weight: 600;
    text-align: center;
    min-width: 84px;
    max-width: 130px;
    cursor: pointer;
  }
  thead th .muted {
    display: block;
    font-weight: 400;
    font-size: 11px;
  }
  th.gene,
  td.gene {
    position: sticky;
    left: 0;
    z-index: 1;
    text-align: left;
    padding: 0 10px;
    min-width: 150px;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border-right: 1px solid var(--border);
    cursor: pointer;
  }
  thead th.gene {
    z-index: 3;
    color: var(--muted);
    font-weight: 500;
    cursor: default;
  }
  td.cell {
    height: 22px;
    text-align: center;
    font-variant-numeric: tabular-nums;
    border: 1px solid var(--bg);
    cursor: pointer;
  }
  td.cell.dark {
    color: #fff;
  }
  td.cell.zero {
    color: var(--muted);
    opacity: 0.5;
  }
  td.cell:hover,
  td.cell.selected {
    outline: 2px solid var(--fg);
    outline-offset: -2px;
  }
  tbody tr:hover td.gene,
  tr.selected td.gene,
  th.selected {
    background-color: var(--hover);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
  }
  .legend .ramp {
    width: 140px;
    height: 10px;
    border-radius: 2px;
    background: linear-gradient(to right, transparent, var(--accent));
    border: 1px solid var(--border);
  }
  .tooltip {
    position: fixed;
    z-index: 10;
    pointer-events: none;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    max-width: 280px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }
  .details {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-height: 38px;
  }
  .details .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
`;
