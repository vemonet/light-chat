// Line chart of the frequencies of LAPIS mutations and lineages over time
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createMcpApp, createSize, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface Period {
  start: string;
  end: string;
  /** Sequences with a date in the period */
  total: number;
}

interface Series {
  name: string;
  kind: "mutation" | "lineage";
  count: number[];
  /** Sequences covering the mutation position, or all sequences of the period for a lineage */
  coverage: number[];
  proportion: (number | null)[];
  /** Wilson 95% interval of the proportion */
  lower: (number | null)[];
  upper: (number | null)[];
}

/** `structuredContent` of the `show_lapis_mutations_over_time` tool */
interface OverTimeData {
  organism: string;
  database: string;
  filters: Record<string, unknown>;
  date_field: string;
  interval: string;
  lineage_field: string | null;
  periods: Period[];
  series: Series[];
}

/** Period under the pointer, with the pointer y in the chart */
interface Hover {
  i: number;
  y: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];
const STRIP_HEIGHT = 46;

const color = (i: number) => `var(--s${(i % 8) + 1})`;
const pct = (p: number | null) => (p == null ? "-" : `${(p * 100).toFixed(p > 0 && p < 0.001 ? 2 : 1)}%`);
const num = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => n.toLocaleString("en-US", { notation: "compact" });

/** Indices of the runs of periods with a proportion, a line is split where a period has no coverage */
function runs(s: Series) {
  const out: number[][] = [[]];
  s.proportion.forEach((p, i) => (p == null ? out.push([]) : out.at(-1)!.push(i)));
  return out.filter((r) => r.length);
}

export default function Widget() {
  const mcp = createMcpApp<OverTimeData>("LAPIS mutations over time", "show_lapis_mutations_over_time");
  // A new tool result recreates the chart, which resets the legend and selection
  return (
    <Show
      when={mcp.data()?.series && mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading frequencies" : "No data"}</h1>
        </header>
      }
    >
      {(data) => <OverTime data={data} mcp={mcp} />}
    </Show>
  );
}

function OverTime(props: { data: OverTimeData; mcp: McpApp<OverTimeData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  /** Period label by interval: "Mar 2024", "Q2 2024" or "2024" */
  function periodLabel(p: Period, short = false) {
    const [y, m] = p.start.split("-").map(Number);
    if (data.interval === "year") return `${y}`;
    if (data.interval === "quarter") return `Q${Math.floor((m - 1) / 3) + 1} ${short ? `'${String(y).slice(2)}` : y}`;
    return short ? `${MONTHS[m - 1]} '${String(y).slice(2)}` : `${MONTHS[m - 1]} ${y}`;
  }
  const where = Object.entries(data.filters)
    .filter(([k]) => k !== "versionStatus" && k !== "isRevocation")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
    .join(", ");
  const kinds = [...new Set(data.series.map((s) => `${s.kind}s`))].join(" and ");
  const subtitle =
    `${data.organism} · ${data.database}${where ? ` · ${where}` : ""} · ${periodLabel(data.periods[0])} - ` +
    `${periodLabel(data.periods.at(-1)!)} by ${data.date_field}`;
  const n = data.periods.length;
  const maxTotal = Math.max(1, ...data.periods.map((p) => p.total));

  // Series hidden from the legend, confidence band, selected period and period under the pointer
  const [hidden, setHidden] = createSignal(new Set<string>());
  const [band, setBand] = createSignal(true);
  const [selected, setSelected] = createSignal<number>();
  const [hover, setHover] = createSignal<Hover>();

  // Chart width and window height, the chart is drawn for them
  let chart!: HTMLDivElement;
  let tip!: HTMLDivElement;
  const { width, windowHeight } = createSize(() => chart);

  // Plot of the proportions on top, strip of the sequences per period below, direct labels on the right
  const layout = createMemo(() => {
    const W = Math.max(320, width());
    const H = mcp.fullscreen() ? Math.max(360, windowHeight() - 190) : 380;
    const series = data.series.map((s, i) => ({ ...s, i })).filter((s) => !hidden().has(s.name));
    const labelled = series.length <= 4;
    const m = { top: 12, right: labelled ? 92 : 16, bottom: 26, left: 44 };
    const plotHeight = H - m.top - m.bottom - STRIP_HEIGHT - 18;
    const step = (W - m.left - m.right) / n;
    const x = (i: number) => m.left + (i + 0.5) * step;
    const y = (p: number) => m.top + plotHeight * (1 - p);
    const stripTop = m.top + plotHeight + 18;
    return { W, H, series, labelled, m, step, x, y, stripTop, baseline: stripTop + STRIP_HEIGHT - 6 };
  });

  // x labels, thinned to fit
  const xLabels = createMemo(() => {
    const { W, m } = layout();
    const every = Math.ceil(n / Math.max(1, Math.floor((W - m.left - m.right) / 58)));
    return data.periods.map((p, i) => ({ p, i })).filter(({ i }) => !(i % every));
  });

  // Direct labels at the last point of each line, pushed apart to avoid overlaps
  const ends = createMemo(() => {
    const { series, labelled, y } = layout();
    if (!labelled) return [];
    const out = series
      .map((s) => {
        const i = s.proportion.findLastIndex((p) => p != null);
        return i < 0 ? null : { s, y: y(s.proportion[i]!) };
      })
      .filter((e) => e !== null)
      .sort((a, b) => a.y - b.y);
    // Push down from the top, then back up from the baseline so no label falls below the plot
    out.forEach((e, k) => k && (e.y = Math.max(e.y, out[k - 1].y + 13)));
    for (let k = out.length - 1; k >= 0; k--)
      out[k].y = Math.min(out[k].y, k === out.length - 1 ? y(0) : out[k + 1].y - 13);
    return out;
  });

  /** Index of the period under the pointer */
  function periodAt(e: MouseEvent) {
    const i = Math.floor((e.clientX - chart.getBoundingClientRect().left - layout().m.left) / layout().step);
    return i >= 0 && i < n ? i : undefined;
  }

  // Tooltip next to the crosshair, on its left near the right edge, placed once its content is rendered
  const [tipPosition, setTipPosition] = createSignal({ left: 0, top: 0 });
  createEffect(() => {
    const h = hover();
    if (!h) return;
    const left = layout().x(h.i) + 14;
    setTipPosition({
      left:
        left + tip.offsetWidth > chart.getBoundingClientRect().width ? layout().x(h.i) - tip.offsetWidth - 14 : left,
      top: Math.max(0, h.y - tip.offsetHeight / 2),
    });
  });

  /** Details of a period, also told to the model */
  function select(i: number) {
    setSelected(i);
    const p = data.periods[i];
    const lines = data.series.map(
      (s) =>
        `${s.name} ${pct(s.proportion[i])} (${s.count[i]} of ${s.coverage[i]}, 95% interval ${pct(s.lower[i])} - ${pct(s.upper[i])})`,
    );
    void mcp.updateContext(
      `The user selected ${periodLabel(p)} (${p.start} to ${p.end}, ${p.total} sequences) in the chart of ` +
        `${data.organism} frequencies over time: ${lines.join("; ")}`,
    );
  }

  function toggle(name: string, on: boolean) {
    const next = new Set(hidden());
    if (on) next.delete(name);
    else next.add(name);
    setHidden(next);
  }

  return (
    <>
      <header>
        <h1>Frequency of {kinds} over time</h1>
        <span class="muted" id="subtitle" title={subtitle}>
          {subtitle}
        </span>
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="toolbar">
        <div class="legend">
          <For each={data.series}>
            {(s, i) => (
              <label class={hidden().has(s.name) ? "off" : ""} title={s.kind}>
                <input
                  type="checkbox"
                  checked={!hidden().has(s.name)}
                  onChange={(e) => toggle(s.name, e.currentTarget.checked)}
                />
                <i style={{ background: color(i()) }} />
                {s.name} <small>{s.kind}</small>
              </label>
            )}
          </For>
        </div>
        <span class="spacer" />
        <label>
          <input type="checkbox" checked={band()} onChange={(e) => setBand(e.currentTarget.checked)} /> 95% interval
        </label>
      </div>

      <div
        id="chart"
        ref={chart}
        onMouseMove={(e) => {
          const i = periodAt(e);
          setHover(i === undefined ? undefined : { i, y: e.clientY - chart.getBoundingClientRect().top });
        }}
        onMouseLeave={() => setHover()}
        onClick={(e) => {
          const i = periodAt(e);
          if (i !== undefined) select(i);
        }}
      >
        <svg width={layout().W} height={layout().H} viewBox={`0 0 ${layout().W} ${layout().H}`}>
          {/* Selected period, behind everything */}
          <Show when={selected() !== undefined}>
            <rect
              x={layout().x(selected()!) - layout().step / 2}
              y={layout().m.top}
              width={layout().step}
              height={layout().baseline - layout().m.top}
              fill="var(--hover)"
            />
          </Show>

          {/* Grid and y axis, in percent */}
          <For each={Y_TICKS}>
            {(t) => (
              <>
                <line
                  x1={layout().m.left}
                  x2={layout().W - layout().m.right}
                  y1={layout().y(t)}
                  y2={layout().y(t)}
                  stroke={t ? "var(--grid)" : "var(--axis)"}
                />
                <text x={layout().m.left - 6} y={layout().y(t) + 4} text-anchor="end">
                  {t * 100}%
                </text>
              </>
            )}
          </For>
          <For each={xLabels()}>
            {({ p, i }) => (
              <text x={layout().x(i)} y={layout().H - 8} text-anchor="middle">
                {periodLabel(p, true)}
              </text>
            )}
          </For>

          {/* Bands, a single period as a thick line */}
          <Show when={band()}>
            <For each={layout().series}>
              {(s) => (
                <For each={runs(s)}>
                  {(r) => (
                    <Show
                      when={r.length > 1}
                      fallback={
                        <line
                          x1={layout().x(r[0])}
                          x2={layout().x(r[0])}
                          y1={layout().y(s.upper[r[0]]!)}
                          y2={layout().y(s.lower[r[0]]!)}
                          stroke={color(s.i)}
                          stroke-opacity="0.35"
                          stroke-width="6"
                          stroke-linecap="round"
                        />
                      }
                    >
                      <path
                        d={`M${[
                          ...r.map((i) => [layout().x(i), layout().y(s.upper[i]!)]),
                          ...r.toReversed().map((i) => [layout().x(i), layout().y(s.lower[i]!)]),
                        ]
                          .map((p) => p.join(","))
                          .join("L")}Z`}
                        fill={color(s.i)}
                        fill-opacity="0.13"
                        stroke="none"
                      />
                    </Show>
                  )}
                </For>
              )}
            </For>
          </Show>

          {/* Lines and points */}
          <For each={layout().series}>
            {(s) => (
              <>
                <For each={runs(s)}>
                  {(r) => (
                    <path
                      d={`M${r.map((i) => `${layout().x(i)},${layout().y(s.proportion[i]!)}`).join("L")}`}
                      fill="none"
                      stroke={color(s.i)}
                      stroke-width="2"
                      stroke-linejoin="round"
                    />
                  )}
                </For>
                <For each={s.proportion}>
                  {(p, i) => (
                    <Show when={p != null}>
                      <circle
                        cx={layout().x(i())}
                        cy={layout().y(p!)}
                        r="3.5"
                        fill={color(s.i)}
                        stroke="var(--bg)"
                        stroke-width="1.5"
                      />
                    </Show>
                  )}
                </For>
              </>
            )}
          </For>
          <For each={ends()}>
            {(e) => (
              <text x={layout().x(n - 1) + 9} y={e.y + 4} class="label">
                {e.s.name.length > 13 ? `${e.s.name.slice(0, 12)}...` : e.s.name}
              </text>
            )}
          </For>

          {/* Sequences per period: the n behind each proportion, the axis is the largest period total */}
          <text x={layout().m.left - 6} y={layout().stripTop + 8} text-anchor="end">
            {compact(maxTotal)}
          </text>
          <text x={layout().m.left - 6} y={layout().stripTop + STRIP_HEIGHT - 8} text-anchor="end">
            seqs
          </text>
          <For each={data.periods}>
            {(p, i) => {
              const h = (STRIP_HEIGHT - 6) * (p.total / maxTotal);
              return (
                <rect
                  x={layout().x(i()) - Math.min(layout().step * 0.35, 14)}
                  y={layout().baseline - h}
                  width={Math.min(layout().step * 0.7, 28)}
                  height={Math.max(h, p.total ? 1 : 0)}
                  rx="2"
                  fill="var(--muted)"
                  fill-opacity="0.35"
                />
              );
            }}
          </For>
          <line
            x1={layout().m.left}
            x2={layout().W - layout().m.right}
            y1={layout().baseline}
            y2={layout().baseline}
            stroke="var(--axis)"
          />

          {/* Crosshair on the period under the pointer */}
          <line
            x1={hover() && layout().x(hover()!.i)}
            x2={hover() && layout().x(hover()!.i)}
            y1={layout().m.top}
            y2={layout().baseline}
            stroke="var(--muted)"
            stroke-dasharray="3 3"
            visibility={hover() ? "visible" : "hidden"}
          />
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
          <Show when={hover()}>
            {(h) => (
              <>
                <b>{periodLabel(data.periods[h().i])}</b>{" "}
                <span class="muted">· {num(data.periods[h().i].total)} sequences</span>
                <table>
                  <tbody>
                    <tr class="muted">
                      <td />
                      <td class="num">share</td>
                      <td class="num">95% interval</td>
                      <td class="num">with / covered</td>
                    </tr>
                    <For each={layout().series}>
                      {(s) => (
                        <tr>
                          <td>
                            <i style={{ background: color(s.i) }} />
                            {s.name}
                          </td>
                          <td class="num">
                            <b>{pct(s.proportion[h().i])}</b>
                          </td>
                          <td class="num muted">
                            {s.lower[h().i] == null ? "" : `${pct(s.lower[h().i])} - ${pct(s.upper[h().i])}`}
                          </td>
                          <td class="num muted">
                            {num(s.count[h().i])} / {num(s.coverage[h().i])}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </>
            )}
          </Show>
        </div>
      </div>

      <div class="details" classList={{ muted: selected() === undefined }}>
        <Show
          when={selected() !== undefined && data.periods[selected()!]}
          fallback="Hover the chart for values, click a period for details"
        >
          {(p) => {
            const i = () => selected()!;
            return (
              <>
                <div>
                  <b>{periodLabel(p())}</b>{" "}
                  <span class="muted">
                    {p().start} to {p().end} · {num(p().total)} sequences
                  </span>
                </div>
                <div class="items">
                  <For each={data.series}>
                    {(s, k) => (
                      <span>
                        <i style={{ background: color(k()) }} />
                        <b>{s.name}</b> {pct(s.proportion[i()])}{" "}
                        <span class="muted">
                          ({num(s.count[i()])} of {num(s.coverage[i()])}, {pct(s.lower[i()])} - {pct(s.upper[i()])})
                        </span>
                      </span>
                    )}
                  </For>
                </div>
                <div class="actions">
                  <button
                    type="button"
                    onClick={() =>
                      void mcp.sendMessage(
                        `What explains the frequencies of ${data.series.map((s) => s.name).join(", ")} in ` +
                          `${data.organism}${where ? ` (${where})` : ""} in ${periodLabel(p())}?`,
                      )
                    }
                  >
                    Ask about this period
                  </button>
                </div>
              </>
            );
          }}
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
    --s8: #e34948;
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
    --s8: #e66767;
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
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .legend label,
  .toolbar > label {
    display: flex;
    gap: 5px;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }
  .legend label.off {
    opacity: 0.45;
  }
  .legend i {
    width: 14px;
    height: 3px;
    border-radius: 2px;
  }
  .legend input,
  .toolbar input {
    margin: 0;
  }
  .legend small {
    color: var(--muted);
  }
  #chart {
    position: relative;
  }
  svg {
    display: block;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  svg text {
    fill: var(--muted);
  }
  svg .label {
    fill: var(--fg);
    font-weight: 500;
  }
  .tip {
    position: absolute;
    pointer-events: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 9px;
    font-size: 12px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
    white-space: nowrap;
    z-index: 2;
  }
  .tip table {
    border-collapse: collapse;
  }
  .tip td {
    padding: 1px 4px;
  }
  .tip td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tip i {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 4px;
  }
  .details {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-height: 38px;
  }
  .details .items {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 16px;
  }
  .details .items i {
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    margin-right: 5px;
  }
  .details .actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
`;
