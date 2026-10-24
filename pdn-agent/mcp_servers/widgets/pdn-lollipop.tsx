// Lollipop plot of the mutations of LAPIS sequences along the genome
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { createMcpApp, createSize, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

/** Gene or segment, with its length in amino acids or nucleotides */
interface Region {
  name: string;
  length: number;
}

interface Mutation {
  mutation: string;
  region: string;
  position: number;
  count: number;
  coverage: number;
  proportion: number;
}

/** `structuredContent` of the `show_lapis_mutation_lollipop` tool */
interface LollipopData {
  organism: string;
  database: string;
  filters: Record<string, unknown>;
  sequence_type: string;
  min_proportion: number;
  total: number;
  regions: Region[];
  mutations: Mutation[];
  truncated: boolean;
}

/** Mutation, else region of the track, under the pointer, with the pointer position in the chart */
interface Hover {
  x: number;
  y: number;
  mu?: Mutation;
  region?: string;
}

const MAX_LABELS = 60;
const MARGIN = { right: 14, bottom: 46, left: 44 };
const TRACK_HEIGHT = 16;
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

const pct = (p: number) => `${(p * 100).toFixed(p < 0.001 ? 2 : 1)}%`;
const num = (n: number) => n.toLocaleString("en-US");
const isDeletion = (mu: Mutation) => mu.mutation.endsWith("-");
/** Mutation name without the gene or segment, e.g. N501Y */
const short = (mu: Mutation) => mu.mutation.split(":").at(-1);

/** Round tick step for a span, e.g. 100, 200, 500 */
function tickStep(span: number, count: number) {
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw)!;
}

/** Number of mutations of each region */
function countByRegion(mutations: Mutation[]) {
  const counts: Record<string, number> = {};
  for (const mu of mutations) counts[mu.region] = (counts[mu.region] ?? 0) + 1;
  return counts;
}

export default function Widget() {
  const mcp = createMcpApp<LollipopData>("LAPIS mutation lollipop", "show_lapis_mutation_lollipop");
  // A new tool result recreates the chart, which resets the zoom, filters and selection
  return (
    <Show
      when={mcp.data()?.mutations && mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading mutations" : "No data"}</h1>
        </header>
      }
    >
      {(data) => <Lollipop data={data} mcp={mcp} />}
    </Show>
  );
}

function Lollipop(props: { data: LollipopData; mcp: McpApp<LollipopData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const kind = data.sequence_type === "amino_acid" ? "gene" : "segment";
  const where = Object.entries(data.filters)
    .filter(([k]) => k !== "versionStatus" && k !== "isRevocation")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
    .join(", ");
  const context = `${data.organism} sequences${where ? ` with ${where}` : ""}`;
  const along = data.regions.length === 1 && kind === "gene" ? `in ${data.regions[0].name}` : "along the genome";
  const subtitle = `${data.organism} · ${data.database} · ${num(data.total)} sequences${where ? ` · ${where}` : ""}`;

  // Colors of the regions with the most mutations, in a fixed order, the others share a neutral color
  const counts = countByRegion(data.mutations);
  const ranked = data.regions.map((r) => r.name).sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));
  const colors: Record<string, string> = {};
  ranked.forEach((name, i) => (colors[name] = i < 7 && counts[name] ? `var(--s${i + 1})` : "var(--other)"));
  const legend = ranked.filter((name) => counts[name] && colors[name] !== "var(--other)");
  const others = ranked.filter((name) => counts[name] && colors[name] === "var(--other)");

  // Options of the toolbar, the zoom is a region name, empty for all
  const [zoom, setZoom] = createSignal(data.regions.length > 1 ? "" : data.regions[0].name);
  const [min, setMin] = createSignal(data.min_proportion);
  const [labels, setLabels] = createSignal(true);
  const [selected, setSelected] = createSignal<Mutation>();
  const [hover, setHover] = createSignal<Hover>();

  // Chart width and window height, the chart is drawn for them
  let chart!: HTMLDivElement;
  let tip!: HTMLDivElement;
  const { width, windowHeight } = createSize(() => chart);

  // Regions side by side, widths by length, with a small gap
  const layout = createMemo(() => {
    const W = Math.max(320, width());
    const H = mcp.fullscreen() ? Math.max(380, windowHeight() - 220) : 360;
    const top = labels() ? 66 : 14;
    const plotHeight = H - top - MARGIN.bottom;
    const regions = zoom() ? data.regions.filter((r) => r.name === zoom()) : data.regions;
    const gap = regions.length > 40 ? 0.5 : 3;
    const totalLength = regions.reduce((s, r) => s + r.length, 0);
    const scale = (W - MARGIN.left - MARGIN.right - gap * (regions.length - 1)) / totalLength;
    const start: Record<string, number> = {};
    let cursor = MARGIN.left;
    for (const r of regions) {
      start[r.name] = cursor;
      cursor += r.length * scale + gap;
    }
    const y = (p: number) => top + plotHeight * (1 - p);
    const x = (mu: Mutation) => start[mu.region] + (mu.position - 0.5) * scale;
    return { W, H, regions, scale, start, x, y, trackY: y(0) + 6 };
  });
  const regionWidth = (r: Region) => Math.max(r.length * layout().scale, 0.5);

  // Mutations above the minimum proportion in the regions shown, the most frequent drawn last so they stay on top
  const shown = createMemo(() =>
    data.mutations
      .filter((mu) => mu.proportion >= min() && layout().start[mu.region] !== undefined)
      .sort((a, b) => a.proportion - b.proportion),
  );
  const shownCounts = createMemo(() => countByRegion(data.mutations.filter((mu) => mu.proportion >= min())));

  // Labels above the heads of the most frequent mutations, where they do not overlap, without the gene shown by the
  // color
  const labelled = createMemo(() => {
    if (!labels()) return [];
    const placed: { mu: Mutation; x: number }[] = [];
    for (const mu of shown().toReversed()) {
      if (placed.length >= MAX_LABELS) break;
      const x = layout().x(mu);
      if (!placed.some((p) => Math.abs(p.x - x) < 11)) placed.push({ mu, x });
    }
    return placed.map((p) => p.mu);
  });

  // Position axis of a single region
  const positionTicks = createMemo(() => {
    const { regions, W } = layout();
    if (regions.length !== 1) return [];
    const step = tickStep(regions[0].length, Math.max(2, Math.floor((W - MARGIN.left - MARGIN.right) / 70)));
    return Array.from({ length: Math.floor(regions[0].length / step) }, (_, i) => (i + 1) * step);
  });

  /** Mutation nearest to the pointer within 14 px, its stick counts as well as its head, else the region of the
   * track under the pointer */
  function hit(e: MouseEvent): Hover | undefined {
    const rect = chart.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { x, y, trackY, regions, start } = layout();
    let best: Mutation | undefined;
    let dist = 14 ** 2;
    for (const mu of shown()) {
      const head = y(mu.proportion);
      const dy = py > head && py < y(0) ? 0 : py - head;
      const d = (px - x(mu)) ** 2 + dy ** 2;
      if (d <= dist) [best, dist] = [mu, d];
    }
    if (best) return { x: px, y: py, mu: best };
    if (py < trackY || py > trackY + TRACK_HEIGHT) return;
    const region = regions.find((r) => px >= start[r.name] && px <= start[r.name] + regionWidth(r));
    return region && { x: px, y: py, region: region.name };
  }

  // Tooltip next to the pointer, on its left near the right edge, placed once its content is rendered
  const [tipPosition, setTipPosition] = createSignal({ left: 0, top: 0 });
  createEffect(() => {
    const h = hover();
    if (!h) return;
    const x = h.x + 14;
    setTipPosition({
      left: x + tip.offsetWidth > width() ? x - tip.offsetWidth - 28 : x,
      top: Math.max(0, h.y - tip.offsetHeight - 8),
    });
  });

  /** Details of a mutation, also told to the model */
  function select(mu: Mutation) {
    setSelected(mu);
    void mcp.updateContext(
      `The user selected the mutation ${mu.mutation} in the lollipop plot of ${context}: ${mu.count} of ` +
        `${mu.coverage} covering sequences (${pct(mu.proportion)})`,
    );
  }

  function onClick(e: MouseEvent) {
    const h = hit(e);
    if (h?.mu) select(h.mu);
    else if (h?.region && !zoom()) setZoom(h.region);
  }

  return (
    <>
      <header>
        <h1>
          {data.mutations.length}
          {data.truncated ? "+" : ""} {data.sequence_type === "amino_acid" ? "amino acid" : "nucleotide"} mutations{" "}
          {along}
        </h1>
        <span class="muted" id="subtitle" title={subtitle}>
          {subtitle}
        </span>
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="toolbar">
        <select aria-label="Gene or segment" onChange={(e) => setZoom(e.currentTarget.value)}>
          <Show when={data.regions.length > 1}>
            <option value="" selected={!zoom()}>
              All {kind}s ({data.mutations.length})
            </option>
          </Show>
          <For each={data.regions}>
            {(r) => (
              <option value={r.name} selected={zoom() === r.name}>
                {r.name} ({counts[r.name] ?? 0})
              </option>
            )}
          </For>
        </select>
        <label>
          Min. proportion
          <input
            type="range"
            min={data.min_proportion}
            max="1"
            step="0.01"
            value={min()}
            onInput={(e) => setMin(Number(e.currentTarget.value))}
          />
          <span id="minValue">{pct(min())}</span>
        </label>
        <label>
          <input type="checkbox" checked={labels()} onChange={(e) => setLabels(e.currentTarget.checked)} /> Labels
        </label>
      </div>

      <div
        id="chart"
        ref={chart}
        style={{ cursor: hover()?.mu || (hover() && !zoom()) ? "pointer" : "default" }}
        onMouseMove={(e) => setHover(hit(e))}
        onMouseLeave={() => setHover()}
        onClick={onClick}
      >
        <svg width={layout().W} height={layout().H} viewBox={`0 0 ${layout().W} ${layout().H}`}>
          {/* Grid and y axis */}
          <For each={Y_TICKS}>
            {(t) => (
              <>
                <line
                  x1={MARGIN.left}
                  x2={layout().W - MARGIN.right}
                  y1={layout().y(t)}
                  y2={layout().y(t)}
                  stroke={t ? "var(--grid)" : "var(--axis)"}
                />
                <text x={MARGIN.left - 6} y={layout().y(t) + 3} text-anchor="end">
                  {t * 100}%
                </text>
              </>
            )}
          </For>

          {/* Region track below the baseline, labels where they fit, click to zoom */}
          <For each={layout().regions}>
            {(r) => (
              <g class="region">
                <rect
                  x={layout().start[r.name]}
                  y={layout().trackY}
                  width={regionWidth(r)}
                  height={TRACK_HEIGHT}
                  rx="3"
                  fill={colors[r.name]}
                  fill-opacity={shownCounts()[r.name] ? 0.3 : 0.12}
                />
                <title>
                  {r.name} · {num(r.length)} {data.sequence_type === "amino_acid" ? "aa" : "nt"}
                  {zoom() ? "" : " · click to zoom"}
                </title>
                <Show when={regionWidth(r) > r.name.length * 7 + 6}>
                  <text x={layout().start[r.name] + regionWidth(r) / 2} y={layout().trackY + 12} text-anchor="middle">
                    {r.name}
                  </text>
                </Show>
              </g>
            )}
          </For>
          <For each={positionTicks()}>
            {(p) => (
              <text
                x={layout().start[layout().regions[0].name] + (p - 0.5) * layout().scale}
                y={layout().trackY + 32}
                text-anchor="middle"
              >
                {num(p)}
              </text>
            )}
          </For>

          {/* Lollipops, hollow heads for deletions */}
          <For each={shown()}>
            {(mu) => {
              const color = colors[mu.region];
              const deletion = isDeletion(mu);
              const isSelected = () => selected() === mu;
              return (
                <>
                  <line
                    x1={layout().x(mu)}
                    x2={layout().x(mu)}
                    y1={layout().y(0)}
                    y2={layout().y(mu.proportion)}
                    stroke={color}
                    stroke-width={isSelected() ? 2 : 1}
                    stroke-opacity="0.7"
                  />
                  <circle
                    cx={layout().x(mu)}
                    cy={layout().y(mu.proportion)}
                    r={isSelected() ? 6 : 4}
                    fill={deletion ? "var(--bg)" : color}
                    stroke={deletion ? color : "var(--bg)"}
                    stroke-width={deletion ? 2 : 1}
                  />
                </>
              );
            }}
          </For>
          <For each={labelled()}>
            {(mu) => (
              <text
                class="mlabel"
                transform={`translate(${layout().x(mu) + 3.5},${layout().y(mu.proportion) - 8}) rotate(-90)`}
              >
                {short(mu)}
              </text>
            )}
          </For>
        </svg>

        <div
          class="tip"
          ref={tip}
          style={{
            display: hover() ? "block" : "none",
            left: `${tipPosition().left}px`,
            top: `${tipPosition().top}px`,
          }}
        >
          <Switch>
            <Match when={hover()?.mu}>
              {(mu) => (
                <>
                  <b>{mu().mutation}</b>
                  <Show when={isDeletion(mu())}>
                    {" "}
                    <span class="muted">deletion</span>
                  </Show>
                  <br />
                  {pct(mu().proportion)}{" "}
                  <span class="muted">
                    · {num(mu().count)} of {num(mu().coverage)} covering sequences
                  </span>
                  <br />
                  <span class="muted">
                    {mu().region} position {num(mu().position)}
                  </span>
                </>
              )}
            </Match>
            <Match when={hover()?.region}>
              {(name) => (
                <>
                  <b>{name()}</b>
                  <br />
                  <span class="muted">
                    {shownCounts()[name()] ?? 0} mutations shown{zoom() ? "" : " · click to zoom"}
                  </span>
                </>
              )}
            </Match>
          </Switch>
        </div>
      </div>

      <div class="legend">
        <For each={legend}>
          {(name) => (
            <span onClick={() => setZoom(name)}>
              <i style={{ background: colors[name] }} />
              {name} <small>{counts[name]}</small>
            </span>
          )}
        </For>
        <Show when={others.length}>
          <span title={others.join(", ")}>
            <i style={{ background: "var(--other)" }} />
            {others.length} other {kind}s <small>{others.reduce((s, n) => s + counts[n], 0)}</small>
          </span>
        </Show>
        <span>
          <i class="hollow" />
          deletion
        </span>
      </div>

      <Show when={data.truncated}>
        <div class="warn muted">
          Only the {data.mutations.length} most frequent mutations are shown, ties at the cut are kept arbitrarily: pick
          one {kind} or a higher minimum proportion to see them all.
        </div>
      </Show>

      <div class="details" classList={{ muted: !selected() }}>
        <Show
          when={selected()}
          fallback="Hover a mutation for its frequency, click it for details, click a gene to zoom"
        >
          {(mu) => (
            <>
              <div>
                <b>{mu().mutation}</b> in {pct(mu().proportion)} of the sequences covering it{" "}
                <span class="muted">
                  · {num(mu().count)} of {num(mu().coverage)} · {mu().region} position {num(mu().position)}
                  {isDeletion(mu()) ? " · deletion" : ""}
                </span>
              </div>
              <div class="actions">
                <button
                  type="button"
                  onClick={() =>
                    void mcp.sendMessage(
                      `What is known about the ${data.organism} mutation ${mu().mutation}, found in ` +
                        `${pct(mu().proportion)} of the ${context}?`,
                    )
                  }
                >
                  Ask about it
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void mcp.sendMessage(
                      `Show the frequency of ${mu().mutation} over time in ${context}, over the last two years.`,
                    )
                  }
                >
                  Show over time
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
    </>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  /* Long filters stay on one line, in full on hover */
  #subtitle {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Categorical palette, light and dark steps of the same hues */
  :root {
    --s1: #2a78d6;
    --s2: #eb6834;
    --s3: #1baf7a;
    --s4: #eda100;
    --s5: #e87ba4;
    --s6: #008300;
    --s7: #4a3aa7;
    --other: #9a9893;
    --grid: #e1e0d9;
    --axis: #c3c2b7;
  }
  :root[data-theme="dark"] {
    --s1: #3987e5;
    --s2: #d95926;
    --s3: #199e70;
    --s4: #c98500;
    --s5: #d55181;
    --s6: #008300;
    --s7: #9085e9;
    --other: #6f6e69;
    --grid: #2c2c2a;
    --axis: #383835;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 12px;
  }
  .toolbar label {
    display: flex;
    gap: 5px;
    align-items: center;
    color: var(--muted);
  }
  .toolbar input[type="range"] {
    width: 120px;
    padding: 0;
  }
  #minValue {
    min-width: 36px;
    font-variant-numeric: tabular-nums;
    color: var(--fg);
  }
  #chart {
    position: relative;
  }
  svg {
    display: block;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  svg text {
    fill: var(--muted);
  }
  svg .mlabel {
    fill: var(--fg);
  }
  svg .region {
    cursor: pointer;
  }
  svg .region text {
    fill: var(--fg);
    font-size: 11px;
    font-weight: 500;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12px;
    margin-top: 4px;
  }
  .legend span {
    display: flex;
    gap: 5px;
    align-items: center;
    cursor: pointer;
  }
  .legend i {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .legend i.hollow {
    background: none !important;
    border: 2px solid var(--muted);
  }
  .legend small {
    color: var(--muted);
  }
  .tip {
    position: absolute;
    pointer-events: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 5px 9px;
    font-size: 12px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
    white-space: nowrap;
    z-index: 2;
  }
  .warn {
    font-size: 12px;
    margin-top: 4px;
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
    gap: 6px;
    margin-top: 6px;
  }
`;
