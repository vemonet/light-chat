// Table of NIAID Data Ecosystem search results with facets, sort and selection sent to the model
import { batch, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface DatasetRow {
  id: string;
  type: string | null;
  name: string | null;
  description: string | null;
  date: string | null;
  repository: string | null;
  /** Record page in the source repository */
  url: string | null;
  doi: string | null;
  pathogens: string[];
  species: string[];
  conditions: string[];
  techniques: string[];
  access: string | null;
}

/** `structuredContent` of the `search_datasets_table` tool */
interface DatasetsData {
  /** Lucene query sent to the NDE API */
  query: string;
  /** Arguments of the search, e.g. {"query": "carbapenem resistance", "pathogen": "..."} */
  filters: Record<string, string>;
  total: number;
  /** Portal URL of a record, with `{_id}` */
  portal: string;
  rows: DatasetRow[];
}

type FacetKey = "repository" | "pathogens" | "species" | "year" | "techniques";
type Column = "selected" | "name" | "repository" | "pathogens" | "species" | "date";

// Facets of the rows, a row can have several values, the values checked are OR-ed
const FACETS: Record<FacetKey, { title: string; limit: number; values: (r: DatasetRow) => string[] }> = {
  repository: { title: "Repository", limit: 10, values: (r) => [r.repository ?? "Unknown"] },
  pathogens: { title: "Pathogen", limit: 10, values: (r) => (r.pathogens.length ? r.pathogens : ["None"]) },
  species: { title: "Species", limit: 8, values: (r) => (r.species.length ? r.species : ["None"]) },
  year: {
    title: "Year",
    limit: 10,
    values: (r) => [r.date && /^\d{4}/.test(r.date) ? r.date.slice(0, 4) : "Unknown"],
  },
  techniques: { title: "Technique", limit: 6, values: (r) => (r.techniques.length ? r.techniques : ["None"]) },
};
const FACET_KEYS = Object.keys(FACETS) as FacetKey[];
const COLUMNS: [Column, string][] = [
  ["name", "Dataset"],
  ["repository", "Repository"],
  ["pathogens", "Pathogens"],
  ["species", "Species"],
  ["date", "Date"],
];

/** Short repository name, e.g. NCBI GEO for "NCBI Gene Expression Omnibus (NCBI GEO)" */
const short = (name: string) => /\(([^)]+)\)$/.exec(name)?.[1] ?? name;

const describe = (r: DatasetRow) =>
  `${r.id} "${r.name}" (${r.repository ?? "-"}, ${r.date ?? "-"}` +
  (r.pathogens.length ? `, pathogens: ${r.pathogens.join(", ")}` : "") +
  (r.species.length ? `, species: ${r.species.join(", ")}` : "") +
  (r.techniques.length ? `, techniques: ${r.techniques.join(", ")}` : "") +
  (r.url ? `, ${r.url}` : "") +
  ")";

/** First 3 values, the others counted in "+n" */
const List3 = (p: { values: string[] }) => (
  <>
    {p.values.slice(0, 3).join(", ")}
    <Show when={p.values.length > 3}>
      {" "}
      <span class="muted">+{p.values.length - 3}</span>
    </Show>
  </>
);

export default function Widget() {
  const mcp = createMcpApp<DatasetsData>("NDE search results", "search_datasets_table");
  // A new tool result recreates the table, which resets the filters, sort and selection
  return (
    <Show
      when={mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading datasets" : "No results"}</h1>
        </header>
      }
    >
      {(data) => <Datasets data={data} mcp={mcp} />}
    </Show>
  );
}

function Datasets(props: { data: DatasetsData; mcp: McpApp<DatasetsData> }) {
  // Fixed for a tool result: free-text query as title, the other search arguments as chips
  const { data, mcp } = props;
  const rows = data.rows;
  const { query, ...filters } = data.filters;
  const portalUrl = (id: string) => data.portal.replace("{_id}", encodeURIComponent(id));

  // Facet values checked, none checked means no filter, and facets showing all their values
  const [checked, setChecked] = createSignal(
    Object.fromEntries(FACET_KEYS.map((k) => [k, new Set<string>()])) as Record<FacetKey, Set<string>>,
  );
  const [expanded, setExpanded] = createSignal(new Set<FacetKey>());
  const [text, setText] = createSignal("");
  const [sort, setSort] = createSignal<{ col?: Column; dir: number }>({ dir: 1 });
  const [selected, setSelected] = createSignal(new Set<string>());
  const [prompt, setPrompt] = createSignal("");

  const matches = (key: FacetKey, r: DatasetRow) =>
    !checked()[key].size || FACETS[key].values(r).some((v) => checked()[key].has(v));

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
          [r.id, r.name, r.description, r.repository, ...r.pathogens, ...r.species, ...r.conditions, ...r.techniques]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
    const { col, dir } = sort();
    if (!col) return list;
    const ids = untrack(selected);
    const key = (r: DatasetRow): string | number => {
      if (col === "selected") return +ids.has(r.id);
      const value = r[col];
      return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
    };
    return list.toSorted((a, b) => {
      const [x, y] = [key(a), key(b)];
      return (typeof x === "string" ? x.localeCompare(String(y)) : x - Number(y)) * dir;
    });
  });
  const selectedRows = createMemo(() => rows.filter((r) => selected().has(r.id)));

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
        ? `The user selected ${list.length} records in the NDE search results table: ` + list.map(describe).join("; ")
        : "The user has not selected records in the NDE search results table",
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
          if (on) next.add(r.id);
          else next.delete(r.id);
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
    const ids = selectedRows().map((r) => `${r.id} (${r.name})`);
    void mcp.sendMessage(`${prompt().trim() || "Summarize these datasets"}: ${ids.join(", ")}`);
    setPrompt("");
  }

  /** Link opened by the host, without selecting the row */
  const open = (url: string) => (e: MouseEvent) => {
    e.stopPropagation();
    mcp.openLink(url);
  };

  return (
    <>
      <header>
        <h1 title={data.query}>{query ? `NDE: ${query}` : "NDE records"}</h1>
        <span class="muted">
          {shown().length} of {rows.length} loaded ({data.total.toLocaleString()} in NDE)
        </span>
        <span class="spacer" />
        <FullscreenButton mcp={mcp} />
      </header>
      <div class="filters">
        <For each={Object.entries(filters)}>
          {([k, v]) => (
            <span class="chip">
              {k}: {v}
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
                      <span>{facet.key === "repository" ? short(value) : value}</span>
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
              placeholder="Filter by name, description, pathogen, species, id"
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
                      checked={shown().length > 0 && shown().every((r) => selected().has(r.id))}
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
                    <tr classList={{ selected: selected().has(r.id) }} onClick={() => toggleRow(r.id)}>
                      <td>
                        <input type="checkbox" checked={selected().has(r.id)} aria-label={`Select ${r.id}`} />
                      </td>
                      <td class="name">
                        <a title="Open in the NDE portal" onClick={open(portalUrl(r.id))}>
                          {r.name ?? r.id}
                        </a>
                        <div class="desc" title={r.description ?? ""}>
                          {r.description ?? ""}
                        </div>
                      </td>
                      <td class="list" title={r.repository ?? ""}>
                        {short(r.repository ?? "")}
                        <Show when={r.url}>
                          {(url) => (
                            <div class="sub">
                              <a title={url()} onClick={open(url())}>
                                source record
                              </a>
                            </div>
                          )}
                        </Show>
                      </td>
                      <td class="list">
                        <List3 values={r.pathogens} />
                      </td>
                      <td class="list">
                        <List3 values={r.species} />
                      </td>
                      <td class="nowrap">{r.date ?? ""}</td>
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
          placeholder="Summarize these datasets"
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
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: -4px 0 10px;
  }
  .chip {
    padding: 0 6px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--panel);
    font-size: 11px;
    line-height: 17px;
  }
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
    max-height: 440px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  :root[data-mode="fullscreen"] .scroll,
  :root[data-mode="fullscreen"] .facets {
    max-height: calc(100vh - 150px);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    padding: 5px 8px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--panel);
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    z-index: 1;
  }
  th[data-dir="asc"]::after {
    content: " \25B2";
  }
  th[data-dir="desc"]::after {
    content: " \25BC";
  }
  td.name {
    min-width: 240px;
    width: 50%;
    overflow-wrap: anywhere;
  }
  td.name a {
    font-weight: 500;
  }
  /* Description cut to 2 lines, full text in the tooltip */
  .desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--muted);
    font-size: 11px;
    margin-top: 2px;
  }
  td.list {
    min-width: 90px;
    max-width: 170px;
    overflow-wrap: anywhere;
  }
  td.nowrap {
    white-space: nowrap;
  }
  .sub {
    font-size: 11px;
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
