// Table of NCBI Pathogen Detection isolates with facets, sort and selection sent to the model
import { batch, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface Isolate {
  /** Pathogen Detection isolate accession, e.g. PDT003433638.1 */
  target: string;
  biosample: string | null;
  assembly: string | null;
  strain: string | null;
  organism: string | null;
  /** Collection date, e.g. 2021-10-15 or 2021 */
  date: string | null;
  /** geo_loc_name, e.g. China: Yunnan */
  location: string | null;
  source: string | null;
  host: string | null;
  epi: string | null;
  /** SNP cluster, e.g. PDS000015678.333 */
  cluster: string | null;
  /** AMR gene symbols and point mutations */
  genes: string[];
}

/** `structuredContent` of the `show_pathogen_isolates_table` tool */
interface IsolatesData {
  organism: string;
  filters: Record<string, string>;
  /** Distinct isolates matching the filters */
  total: number | null;
  rows: Isolate[];
}

type FacetKey = "country" | "year" | "source" | "genes";
type Column = "selected" | "target" | "strain" | "date" | "location" | "source" | "genes";

const URLS = {
  target: (id: string) => `https://www.ncbi.nlm.nih.gov/pathogens/isolates/#${id}`,
  biosample: (id: string) => `https://www.ncbi.nlm.nih.gov/biosample/${id}`,
  assembly: (id: string) => `https://www.ncbi.nlm.nih.gov/datasets/genome/${id}/`,
};
// Genes shown in a row before "+n"
const MAX_CHIPS = 6;
// Labels of the query filters shown as chips
const FILTER_LABELS: Record<string, string> = {
  geo_loc_name: "country",
  collection_year: "collected",
  AMR_genotypes: "genes",
  epi_type: "type",
};
// Facets of the rows, a row can have several values. Genes: isolates carrying all the values checked
const FACETS: Record<FacetKey, { title: string; limit: number; values: (r: Isolate) => string[] }> = {
  country: { title: "Country", limit: 12, values: (r) => [(r.location ?? "").split(":")[0].trim() || "Unknown"] },
  year: {
    title: "Collection year",
    limit: 12,
    values: (r) => [r.date && /^\d{4}/.test(r.date) ? r.date.slice(0, 4) : "Unknown"],
  },
  source: { title: "Isolation source", limit: 10, values: (r) => [r.source || "Unknown"] },
  genes: { title: "AMR genes (all checked)", limit: 15, values: (r) => r.genes },
};
const FACET_KEYS = Object.keys(FACETS) as FacetKey[];
const COLUMNS: [Column, string][] = [
  ["target", "Isolate · BioSample"],
  ["strain", "Strain · assembly"],
  ["date", "Collected"],
  ["location", "Location"],
  ["source", "Source · host"],
  ["genes", "AMR genes"],
];

const describe = (r: Isolate) =>
  `${r.target} (BioSample ${r.biosample ?? "-"}, strain ${r.strain ?? "-"}, ${r.location ?? "-"}, ${r.date ?? "-"}, ` +
  `${r.source ?? "-"}, AMR genes: ${r.genes.slice(0, 15).join(" ") || "none"}${r.genes.length > 15 ? " ..." : ""})`;

export default function Widget() {
  const mcp = createMcpApp<IsolatesData>("Pathogen Detection isolates", "show_pathogen_isolates_table");
  // A new tool result recreates the table, which resets the filters, sort and selection
  return (
    <Show
      when={mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading isolates" : "No isolates"}</h1>
        </header>
      }
    >
      {(data) => <Isolates data={data} mcp={mcp} />}
    </Show>
  );
}

function Isolates(props: { data: IsolatesData; mcp: McpApp<IsolatesData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const rows = data.rows;
  // Genes of the query filter, first and highlighted in the rows
  const wanted = new Set((data.filters.AMR_genotypes ?? "").split(", ").filter(Boolean));
  const filters = Object.entries(data.filters).filter(([k]) => k !== "taxgroup_name");

  // Facet values checked, none checked means no filter, and facets showing all their values
  const [checked, setChecked] = createSignal(
    Object.fromEntries(FACET_KEYS.map((k) => [k, new Set<string>()])) as Record<FacetKey, Set<string>>,
  );
  const [expanded, setExpanded] = createSignal(new Set<FacetKey>());
  const [text, setText] = createSignal("");
  const [sort, setSort] = createSignal<{ col?: Column; dir: number }>({ dir: 1 });
  const [selected, setSelected] = createSignal(new Set<string>());
  const [prompt, setPrompt] = createSignal("");

  const matches = (key: FacetKey, r: Isolate) => {
    const values = checked()[key];
    if (!values.size) return true;
    const own = FACETS[key].values(r);
    return key === "genes" ? [...values].every((v) => own.includes(v)) : own.some((v) => values.has(v));
  };

  /** Facet values with their counts among the rows matching the other facets, checked values stay visible when the
   * list is cut */
  const facetLists = createMemo(() =>
    FACET_KEYS.map((key) => {
      const others = rows.filter((r) => FACET_KEYS.every((k) => k === key || matches(k, r)));
      const counts = new Map<string, number>();
      for (const r of others) for (const v of FACETS[key].values(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
      const list = [...counts].sort((a, b) =>
        key === "year"
          ? Number(a[0] === "Unknown") - Number(b[0] === "Unknown") || b[0].localeCompare(a[0])
          : b[1] - a[1] || a[0].localeCompare(b[0]),
      );
      const limit = expanded().has(key) ? list.length : FACETS[key].limit;
      return { key, total: list.length, shown: list.filter(([v], i) => i < limit || checked()[key].has(v)) };
    }),
  );

  // Rows matching the facets and the text filter, sorted. The selection is read when sorting, rows do not move when
  // they are selected
  const shown = createMemo(() => {
    const q = text().toLowerCase();
    const list = rows.filter(
      (r) =>
        FACET_KEYS.every((k) => matches(k, r)) &&
        (!q ||
          [r.target, r.biosample, r.assembly, r.strain, r.location, r.source, r.host, ...r.genes]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
    const { col, dir } = sort();
    if (!col) return list;
    const ids = untrack(selected);
    const key = (r: Isolate): string | number =>
      col === "selected" ? +ids.has(r.target) : col === "genes" ? r.genes.length : (r[col] ?? "");
    return list.toSorted((a, b) => {
      const [x, y] = [key(a), key(b)];
      return (typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y)) * dir;
    });
  });
  const selectedRows = createMemo(() => rows.filter((r) => selected().has(r.target)));
  const total = data.total == null ? "" : ` · ${data.total.toLocaleString()} isolates match`;

  function toggleFacet(key: FacetKey, value: string, on: boolean) {
    setChecked((prev) => {
      const values = new Set(prev[key]);
      if (on) values.add(value);
      else values.delete(value);
      return { ...prev, [key]: values };
    });
  }

  function toggleExpanded(key: FacetKey) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Selected rows, told to the model with the next message */
  function selectionChanged() {
    const list = selectedRows();
    void mcp.updateContext(
      list.length
        ? `The user selected ${list.length} ${data.organism} isolates in the Pathogen Detection table: ` +
            list.map(describe).join("; ")
        : "The user has not selected isolates in the Pathogen Detection table",
    );
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
    selectionChanged();
  }

  // Header checkbox: (un)selects the rows shown, which are sorted again
  function selectShown(on: boolean) {
    batch(() => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const r of shown()) {
          if (on) next.add(r.target);
          else next.delete(r.target);
        }
        return next;
      });
      setSort((s) => ({ ...s }));
    });
    selectionChanged();
  }

  const sortBy = (col: Column) => setSort((s) => ({ col, dir: s.col === col ? -s.dir : 1 }));
  const dirOf = (col: Column) => (sort().col === col ? (sort().dir > 0 ? "asc" : "desc") : undefined);

  function send() {
    const ids = selectedRows().map((r) => `${r.target} (${r.biosample ?? r.strain ?? ""})`);
    void mcp.sendMessage(`${prompt().trim() || "Compare these isolates"}: ${data.organism} isolates ${ids.join(", ")}`);
    setPrompt("");
  }

  /** Link to an NCBI page, opened by the host */
  const Link = (p: { kind: keyof typeof URLS; id: string | null }) => (
    <Show when={p.id}>
      {(id) => (
        <a
          onClick={(e) => {
            e.stopPropagation();
            mcp.openLink(URLS[p.kind](id()));
          }}
        >
          {id()}
        </a>
      )}
    </Show>
  );

  /** Genes of the query filter first, highlighted, the others counted in "+n" */
  const Genes = (p: { genes: string[] }) => {
    const sorted = p.genes.toSorted((a, b) => Number(wanted.has(b)) - Number(wanted.has(a)));
    return (
      <>
        <For each={sorted.slice(0, MAX_CHIPS)}>
          {(g) => (
            <span class="chip" classList={{ hit: wanted.has(g) }}>
              {g}
            </span>
          )}
        </For>
        <Show when={p.genes.length > MAX_CHIPS}>
          <span class="muted" title={sorted.slice(MAX_CHIPS).join(", ")}>
            +{p.genes.length - MAX_CHIPS}
          </span>
        </Show>
      </>
    );
  };

  return (
    <>
      <header>
        <h1>{data.organism} isolates</h1>
        <span class="muted">
          {shown().length} of {rows.length} most recently added shown{total}
        </span>
        <span class="spacer" />
        <FullscreenButton mcp={mcp} />
      </header>
      <div class="filters">
        <For each={filters}>
          {([k, v]) => (
            <span class="chip">
              {FILTER_LABELS[k] ?? k.replace("_", " ")}: {v}
            </span>
          )}
        </For>
      </div>

      <div class="layout">
        <div class="facets">
          <For each={facetLists()}>
            {(facet) => (
              <>
                <h2>
                  {FACETS[facet.key].title}
                  <Show when={checked()[facet.key].size}>
                    <a onClick={() => setChecked((prev) => ({ ...prev, [facet.key]: new Set() }))}>clear</a>
                  </Show>
                </h2>
                <For each={facet.shown}>
                  {([value, n]) => (
                    <label title={value}>
                      <input
                        type="checkbox"
                        checked={checked()[facet.key].has(value)}
                        onChange={(e) => toggleFacet(facet.key, value, e.currentTarget.checked)}
                      />
                      <span>{value}</span>
                      <span class="muted">{n}</span>
                    </label>
                  )}
                </For>
                <Show when={facet.total > FACETS[facet.key].limit}>
                  <a class="more" onClick={() => toggleExpanded(facet.key)}>
                    {expanded().has(facet.key) ? "Show less" : `Show all ${facet.total}`}
                  </a>
                </Show>
              </>
            )}
          </For>
        </div>

        <div>
          <div class="toolbar">
            <input
              type="search"
              placeholder="Filter by accession, strain, location, source, gene"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </div>
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th data-dir={dirOf("selected")} onClick={() => sortBy("selected")}>
                    <input
                      type="checkbox"
                      aria-label="Select all shown"
                      checked={shown().length > 0 && shown().every((r) => selected().has(r.target))}
                      onClick={(e) => {
                        e.stopPropagation();
                        selectShown(e.currentTarget.checked);
                      }}
                    />
                  </th>
                  <For each={COLUMNS}>
                    {([col, label]) => (
                      <th data-dir={dirOf(col)} onClick={() => sortBy(col)}>
                        {label}
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={shown()}>
                  {(r) => (
                    <tr classList={{ selected: selected().has(r.target) }} onClick={() => toggleRow(r.target)}>
                      <td>
                        <input type="checkbox" checked={selected().has(r.target)} aria-label={`Select ${r.target}`} />
                      </td>
                      <td>
                        <Link kind="target" id={r.target} />
                        <div class="sub">
                          <Link kind="biosample" id={r.biosample} />
                        </div>
                      </td>
                      <td class="wrap">
                        {r.strain ?? ""}
                        <div class="sub">
                          <Link kind="assembly" id={r.assembly} />
                        </div>
                      </td>
                      <td>{r.date ?? ""}</td>
                      <td class="wrap">{r.location ?? ""}</td>
                      <td class="wrap">
                        {r.source ?? ""}
                        <div class="sub muted">{r.host ?? ""}</div>
                      </td>
                      <td class="genes">
                        <Genes genes={r.genes} />
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="selection">
        <span class="muted">{selectedRows().length ? `${selectedRows().length} selected` : "No selection"}</span>
        <input
          placeholder="Compare these isolates"
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && selectedRows().length) send();
          }}
        />
        <button type="button" class="primary" disabled={!selectedRows().length} onClick={send}>
          Send
        </button>
      </div>
    </>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  .layout {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 12px;
  }
  @media (max-width: 600px) {
    .layout {
      grid-template-columns: 1fr;
    }
    .facets {
      max-height: 200px;
    }
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: -4px 0 10px;
  }
  .chip {
    display: inline-block;
    padding: 0 6px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--panel);
    font-size: 11px;
    line-height: 17px;
    white-space: nowrap;
  }
  .chip.hit {
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .facets {
    font-size: 12px;
    max-height: 450px;
    overflow-y: auto;
  }
  .facets h2 {
    display: flex;
    font-size: 12px;
    margin: 10px 0 4px;
    color: var(--muted);
    font-weight: 600;
  }
  .facets h2:first-child {
    margin-top: 0;
  }
  .facets h2 a {
    margin-left: auto;
    font-weight: 400;
  }
  .facets label {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 1px 0;
    cursor: pointer;
  }
  .facets label span:first-of-type {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facets .more {
    font-size: 11px;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .toolbar input {
    flex: 1;
    min-width: 0;
  }
  .scroll {
    max-height: 420px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  :root[data-mode="fullscreen"] .scroll,
  :root[data-mode="fullscreen"] .facets {
    max-height: calc(100vh - 170px);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    padding: 4px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    vertical-align: top;
  }
  td.wrap {
    white-space: normal;
    min-width: 80px;
    max-width: 160px;
    overflow-wrap: anywhere;
  }
  td.genes {
    white-space: normal;
    min-width: 170px;
  }
  .sub {
    font-size: 11px;
  }
  td.genes .chip {
    margin: 0 2px 2px 0;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--panel);
    cursor: pointer;
    user-select: none;
    z-index: 1;
  }
  th[data-dir="asc"]::after {
    content: " \25B2";
  }
  th[data-dir="desc"]::after {
    content: " \25BC";
  }
  tbody tr {
    cursor: pointer;
  }
  tbody tr:hover,
  tr.selected {
    background: var(--hover);
  }
  .selection {
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 8px;
  }
  .selection input {
    flex: 1;
    min-width: 0;
  }
`;
