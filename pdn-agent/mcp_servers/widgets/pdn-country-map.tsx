// World map of the LAPIS sequences by country, d3 for the projection, colors and zoom
import * as d3 from "d3";
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import * as topojson from "topojson-client";
import topo from "world-atlas/countries-110m.json";
import { createMcpApp, createSize, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface CountryCount {
  country: string;
  count: number;
}

/** `structuredContent` of the `show_lapis_country_map` tool */
interface CountryData {
  organism: string;
  database: string;
  filters: Record<string, unknown>;
  country_field: string;
  total: number;
  /** Sequences without a country */
  unknown: number;
  rows: CountryCount[];
}

/** Country of the list, with the name of its shape on the map, null when too small for this map */
interface Row extends CountryCount {
  feature: string | null;
}

/** Shape under the pointer, with the pointer position in the map */
interface Hover {
  name: string;
  x: number;
  y: number;
}

// LAPIS country names differing from the world-atlas names (keys normalized by norm)
const ALIASES: Record<string, string> = {
  usa: "United States of America",
  "united states": "United States of America",
  us: "United States of America",
  "democratic republic of the congo": "Dem. Rep. Congo",
  "dr congo": "Dem. Rep. Congo",
  drc: "Dem. Rep. Congo",
  zaire: "Dem. Rep. Congo",
  "congo democratic republic": "Dem. Rep. Congo",
  "republic of the congo": "Congo",
  "congo brazzaville": "Congo",
  "central african republic": "Central African Rep.",
  "ivory coast": "Cote d'Ivoire",
  "czech republic": "Czechia",
  "viet nam": "Vietnam",
  "south sudan": "S. Sudan",
  "bosnia and herzegovina": "Bosnia and Herz.",
  "dominican republic": "Dominican Rep.",
  "equatorial guinea": "Eq. Guinea",
  swaziland: "eSwatini",
  "solomon islands": "Solomon Is.",
  "north macedonia": "Macedonia",
  "western sahara": "W. Sahara",
  "falkland islands": "Falkland Is.",
  "russian federation": "Russia",
  "lao pdr": "Laos",
  "lao people's democratic republic": "Laos",
  "syrian arab republic": "Syria",
  "republic of korea": "South Korea",
  korea: "South Korea",
  "democratic people's republic of korea": "North Korea",
  "united republic of tanzania": "Tanzania",
  "republic of moldova": "Moldova",
  "brunei darussalam": "Brunei",
  "east timor": "Timor-Leste",
  "state of palestine": "Palestine",
  "west bank": "Palestine",
  gaza: "Palestine",
  burma: "Myanmar",
  turkiye: "Turkey",
  uk: "United Kingdom",
  "great britain": "United Kingdom",
  england: "United Kingdom",
  scotland: "United Kingdom",
  wales: "United Kingdom",
  "northern ireland": "United Kingdom",
};
/** Lower case, no accents, no "the", no parenthesized or comma suffix: "Iran (Islamic Republic of)" -> "iran" */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s*\(.*\)|,.*$/g, "")
    .replace(/^the\s+/, "")
    .replace(/[-_]/g, " ")
    .trim();

// World map, without Antarctica, the JSON import is typed with plain strings
const world = topojson.feature(
  topo as unknown as TopoJSON.Topology,
  topo.objects.countries as unknown as TopoJSON.GeometryCollection<{ name: string }>,
);
const features = world.features.filter((f) => f.properties.name !== "Antarctica");
const LEGEND_WIDTH = 220;
const TICKS = [1, 10, 100, 1000, 10000, 100000, 1000000];

const num = (n: number) => n.toLocaleString("en-US");
const cssColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function Widget() {
  const mcp = createMcpApp<CountryData>("LAPIS sequences by country", "show_lapis_country_map");
  // A new tool result recreates the map, which resets the zoom, filter and selection
  return (
    <Show
      when={mcp.data()?.rows && mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading sequences by country" : "No data"}</h1>
        </header>
      }
    >
      {(data) => <CountryMap data={data} mcp={mcp} />}
    </Show>
  );
}

function CountryMap(props: { data: CountryData; mcp: McpApp<CountryData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const where = Object.entries(data.filters)
    .filter(([k]) => k !== "versionStatus" && k !== "isRevocation")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
    .join(", ");
  const subtitle = `${data.database} · ${data.country_field}${where ? ` · ${where}` : ""}`;
  const share = (n: number) => `${((100 * n) / data.total).toFixed(n / data.total < 0.001 ? 2 : 1)}%`;

  // LAPIS countries matched to the atlas shapes, summing the names that map to one shape
  const byName = new Map(features.map((f) => [norm(f.properties.name), f.properties.name]));
  const counts = new Map<string, number>();
  const rows: Row[] = data.rows.map((r) => {
    const key = norm(r.country);
    const name = byName.get(key) ?? (ALIASES[key] && byName.get(norm(ALIASES[key])));
    if (name) counts.set(name, (counts.get(name) ?? 0) + r.count);
    return { ...r, feature: name ?? null };
  });
  const max = Math.max(1, ...counts.values());
  const maxRow = Math.max(1, ...rows.map((r) => r.count));

  // Filter of the list, selected country, shape highlighted from the list, shape under the pointer
  const [filter, setFilter] = createSignal("");
  const [selected, setSelected] = createSignal<Row>();
  const [highlight, setHighlight] = createSignal<string | null>();
  const [hover, setHover] = createSignal<Hover>();
  const shown = createMemo(() => rows.filter((r) => !filter() || r.country.toLowerCase().includes(filter())));

  // Map width and window height, the height follows the width
  let box!: HTMLDivElement;
  let svg!: SVGSVGElement;
  let tip!: HTMLDivElement;
  const { width, windowHeight } = createSize(() => box);
  const size = createMemo(
    () => {
      const W = Math.max(300, width());
      return { W, H: mcp.fullscreen() ? Math.min(W * 0.55, windowHeight() - 170) : W * 0.5 };
    },
    undefined,
    { equals: (a, b) => a.W === b.W && a.H === b.H },
  );
  const path = createMemo(() => {
    const { W, H } = size();
    const projection = d3.geoEqualEarth().fitExtent(
      [
        [4, 4],
        [W - 4, H - 4],
      ],
      { type: "FeatureCollection", features },
    );
    return d3.geoPath(projection);
  });

  // Log color scale, read again from the CSS when the host theme changes
  const scale = createMemo(() => {
    mcp.host();
    return d3
      .scaleSequentialLog(d3.interpolateLab(cssColor("--low"), cssColor("--high")))
      .domain([1, Math.max(2, max)]);
  });

  // Zoom with ctrl or cmd + wheel, double click, or pinch, pan by dragging: plain wheel keeps scrolling the chat
  const [transform, setTransform] = createSignal<string>();
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([1, 12])
    .filter((e: MouseEvent | WheelEvent) => (e.type === "wheel" ? e.ctrlKey || e.metaKey : !e.button))
    .on("zoom", (e: d3.D3ZoomEvent<SVGSVGElement, unknown>) => setTransform(String(e.transform)));
  onMount(() => d3.select(svg).call(zoom));
  // The pan extent is the map, a new size resets the zoom
  createEffect(
    on(size, ({ W, H }, prev) => {
      zoom.translateExtent([
        [0, 0],
        [W, H],
      ]);
      if (prev) zoom.transform(d3.select(svg), d3.zoomIdentity);
    }),
  );

  // Tooltip below right of the pointer, on its left near the right edge, placed once its content is rendered
  const [tipPosition, setTipPosition] = createSignal({ left: 0, top: 0 });
  createEffect(() => {
    const h = hover();
    if (!h) return;
    setTipPosition({
      left: h.x + tip.offsetWidth > box.getBoundingClientRect().width ? h.x - tip.offsetWidth - 24 : h.x,
      top: h.y,
    });
  });
  function onMove(e: MouseEvent, name: string) {
    const r = box.getBoundingClientRect();
    setHover({ name, x: e.clientX - r.left + 12, y: e.clientY - r.top + 12 });
  }

  /** Details of a country, also told to the model */
  function select(row: Row) {
    setSelected(row);
    void mcp.updateContext(
      `The user selected ${row.country} (${data.country_field}) on the map of ${data.organism} sequences` +
        `${where ? ` with filters ${where}` : ""}: ${row.count} of ${data.total} sequences`,
    );
  }

  return (
    <>
      <header>
        <h1>
          {num(data.total)} {data.organism} sequences by country
        </h1>
        <span class="muted" id="subtitle" title={subtitle}>
          {subtitle}
        </span>
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="layout">
        <div id="map" ref={box}>
          <svg ref={svg} viewBox={`0 0 ${size().W} ${size().H}`}>
            <g transform={transform()}>
              <For each={features}>
                {(f) => {
                  const name = f.properties.name;
                  const count = counts.get(name);
                  const row = rows.find((r) => r.feature === name);
                  return (
                    <path
                      d={path()(f) ?? undefined}
                      class={`country${count ? "" : " empty"}`}
                      classList={{ sel: selected()?.feature === name, hl: highlight() === name }}
                      fill={count ? scale()(count) : undefined}
                      onMouseMove={(e) => onMove(e, name)}
                      onMouseLeave={() => setHover()}
                      onClick={() => row && select(row)}
                    />
                  );
                }}
              </For>
            </g>
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
              {(h) => {
                // LAPIS names of the country, several when they map to one shape, e.g. Zaire
                const names = () => rows.filter((r) => r.feature === h().name).map((r) => r.country);
                const count = () => counts.get(h().name) ?? 0;
                return (
                  <>
                    <b>{names().join(", ") || h().name}</b>
                    <br />
                    <Show when={count()} fallback={<span class="muted">No sequence</span>}>
                      {num(count())} sequences · {share(count())}
                    </Show>
                  </>
                );
              }}
            </Show>
          </div>
          <button
            type="button"
            id="reset"
            title="Zoom with ctrl + wheel or a double click, drag to pan"
            onClick={() => zoom.transform(d3.select(svg).transition(), d3.zoomIdentity)}
          >
            Reset zoom
          </button>
        </div>

        <div class="side">
          <input
            id="filter"
            type="search"
            placeholder="Filter countries"
            onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
          />
          <div class="list" onMouseLeave={() => setHighlight()}>
            <For each={shown()} fallback={<div class="row muted">No country</div>}>
              {(r) => (
                <div
                  class="row"
                  classList={{ sel: selected()?.country === r.country }}
                  onClick={() => select(r)}
                  onMouseEnter={() => setHighlight(r.feature)}
                >
                  <span>
                    {r.country}
                    <Show when={!r.feature}>
                      {" "}
                      <small title="Too small for this map">not on map</small>
                    </Show>
                  </span>
                  <span class="n">
                    {num(r.count)} <small>{share(r.count)}</small>
                  </span>
                  <span class="bar" style={{ width: `${(100 * r.count) / maxRow}%` }} />
                </div>
              )}
            </For>
          </div>
        </div>
      </div>

      {/* Gradient of the log scale with ticks at powers of ten */}
      <div class="legend">
        <span>Sequences</span>
        <svg width={LEGEND_WIDTH + 30} height="26">
          <defs>
            <linearGradient id="g">
              <For each={d3.range(0, 1.01, 0.1)}>
                {(t) => <stop offset={t} stop-color={scale()(Math.pow(Math.max(2, max), t))} />}
              </For>
            </linearGradient>
          </defs>
          <rect x="4" y="2" width={LEGEND_WIDTH} height="9" rx="2" fill="url(#g)" />
          <For each={TICKS.filter((t) => t <= max)}>
            {(t) => (
              <text
                x={4 + (LEGEND_WIDTH * Math.log(t)) / Math.log(Math.max(2, max))}
                y="23"
                text-anchor="middle"
                font-size="10"
              >
                {d3.format("~s")(t)}
              </text>
            )}
          </For>
        </svg>
        <span>
          {num(data.total)} sequences{data.unknown ? ` · ${num(data.unknown)} without a country` : ""}
        </span>
      </div>

      <div class="details" classList={{ muted: !selected() }}>
        <Show when={selected()} fallback="Hover a country for its count, click it for details">
          {(row) => (
            <>
              <div>
                <b>{row().country}</b> {num(row().count)} {data.organism} sequences{" "}
                <span class="muted">
                  · {share(row().count)} of {num(data.total)} · rank {rows.indexOf(row()) + 1} of {rows.length}
                </span>
              </div>
              <div class="actions">
                <button
                  type="button"
                  onClick={() =>
                    void mcp.sendMessage(
                      `What do the ${data.organism} sequences from ${row().country}${where ? ` (${where})` : ""} ` +
                        "show, e.g. their lineages and collection dates?",
                    )
                  }
                >
                  Ask about {row().country}
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
  /* Sequential blue ramp, the low end recedes toward the surface */
  :root {
    --low: #cde2fb;
    --high: #0d366b;
    --land: #eeeeea;
  }
  :root[data-theme="dark"] {
    --low: #1f4a80;
    --high: #9ec5f4;
    --land: #2a2d33;
  }
  .layout {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  #map {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
  }
  #map svg {
    display: block;
    width: 100%;
    height: auto;
  }
  .country {
    stroke: var(--bg);
    stroke-width: 0.5;
    vector-effect: non-scaling-stroke;
    cursor: pointer;
  }
  #reset {
    position: absolute;
    right: 4px;
    bottom: 4px;
    font-size: 11px;
    padding: 1px 7px;
  }
  .country.empty {
    fill: var(--land);
    cursor: default;
  }
  .country:hover,
  .country.hl {
    stroke: var(--fg);
    stroke-width: 1.2;
  }
  .country.sel {
    stroke: var(--accent);
    stroke-width: 2;
  }
  .side {
    flex: 0 0 230px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .side input {
    width: 100%;
  }
  .list {
    max-height: 330px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 12px;
  }
  :root[data-mode="fullscreen"] .list {
    max-height: calc(100vh - 170px);
  }
  .row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    padding: 4px 8px;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }
  .row:last-child {
    border-bottom: 0;
  }
  .row:hover,
  .row.sel {
    background: var(--hover);
  }
  .row .n {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .row .bar {
    grid-column: 1 / 3;
    height: 3px;
    border-radius: 2px;
    background: var(--accent);
    opacity: 0.55;
  }
  .row small {
    color: var(--muted);
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--muted);
    margin-top: 4px;
  }
  .legend svg text {
    fill: var(--muted);
    font-variant-numeric: tabular-nums;
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
  @media (max-width: 640px) {
    .layout {
      flex-direction: column;
      align-items: stretch;
    }
    .side {
      flex-basis: auto;
    }
  }
`;
