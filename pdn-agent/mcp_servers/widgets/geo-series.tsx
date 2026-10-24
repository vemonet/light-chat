// Explorer of a GEO Series: metadata, table of its samples to select and send back, supplementary files
import { createMemo, createSignal, For, onMount, Show, untrack, type JSX } from "solid-js";
import { Logo } from "./lib/logos.tsx";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface GeoSample {
  accession: string;
  title: string;
  source: string | null;
  organism: string | null;
  /** e.g. {"strain": "K-12", "treatment": "control"} */
  characteristics: Record<string, string>;
  description: string | null;
  sra: string | null;
  files: string[];
}

interface GeoFile {
  name: string;
  url: string;
  size: string | null;
  modified: string | null;
  directory: boolean;
}

interface GeoPlatform {
  accession: string;
  title: string;
}

/** `structuredContent` of the `show_geo_series` tool */
interface GeoSeriesData {
  accession: string;
  title: string;
  summary: string;
  design: string | null;
  types: string[];
  organism: string;
  platforms: GeoPlatform[];
  submitted: string | null;
  public: string | null;
  updated: string | null;
  contributors: string[];
  pubmed: string[];
  bioproject: string | null;
  subseries: string[];
  superseries: string[];
  url: string;
  sample_count: number;
  samples: GeoSample[];
  samples_note: string | null;
  files: GeoFile[];
  files_url: string | null;
  files_note: string | null;
}

/** Column of the samples table, `get` gives the value of a sample */
interface Column {
  key: string;
  label: string;
  get: (s: GeoSample) => string | null | undefined;
}

const geoUrl = (acc: string) => `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${acc}`;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Values of the fields varying between samples become columns, the shared ones are shown once */
function buildColumns(samples: GeoSample[]) {
  const fields: Column[] = [
    { key: "source", label: "Source", get: (x) => x.source },
    { key: "organism", label: "Organism", get: (x) => x.organism },
    ...[...new Set(samples.flatMap((x) => Object.keys(x.characteristics)))].map((k) => ({
      key: `c:${k}`,
      label: k,
      get: (x: GeoSample) => x.characteristics[k],
    })),
    { key: "description", label: "Description", get: (x) => x.description },
  ];
  const shared: [string, string][] = [];
  const columns: Column[] = [
    { key: "accession", label: "Sample", get: (x) => x.accession },
    { key: "title", label: "Title", get: (x) => x.title },
  ];
  for (const f of fields) {
    const values = new Set(samples.map((x) => f.get(x) ?? ""));
    const [first] = values;
    if (values.size > 1) columns.push(f);
    else if (first && samples.length > 1) shared.push([f.label, first]);
  }
  return { columns, shared };
}

export default function Widget() {
  const mcp = createMcpApp<GeoSeriesData>("GEO series explorer", "show_geo_series");
  // A new tool result recreates the explorer, which resets the filter, sort and selection
  return (
    <Show
      when={mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading series" : "No series"}</h1>
        </header>
      }
    >
      {(data) => <Series data={data} mcp={mcp} />}
    </Show>
  );
}

function Series(props: { data: GeoSeriesData; mcp: McpApp<GeoSeriesData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const { columns, shared } = buildColumns(data.samples);
  const link = (url: string, text: string) => <a onClick={() => mcp.openLink(url)}>{text}</a>;
  /** Links joined by commas, null when there is none */
  const links = (list: string[], url: (x: string) => string) =>
    list.length
      ? list.map((x, i) => (
          <>
            {i ? ", " : ""}
            {link(url(x), x)}
          </>
        ))
      : null;
  // Metadata shown when they have a value
  const meta: [string, JSX.Element][] = [
    ["Organism", data.organism],
    ["Type", data.types.join(", ")],
    [
      data.platforms.length > 1 ? "Platforms" : "Platform",
      data.platforms.length
        ? data.platforms.map((p, i) => (
            <>
              {i ? ", " : ""}
              {link(geoUrl(p.accession), p.accession)}
              <Show when={p.title}>
                {" "}
                <span class="muted">{p.title}</span>
              </Show>
            </>
          ))
        : null,
    ],
    ["Public", data.public],
    ["Submitted", data.submitted],
    ["Updated", data.updated],
    [
      "BioProject",
      data.bioproject && link(`https://www.ncbi.nlm.nih.gov/bioproject/${data.bioproject}`, data.bioproject),
    ],
    ["SubSeries", links(data.subseries, geoUrl)],
    ["Part of", links(data.superseries, geoUrl)],
    ["PubMed", links(data.pubmed, (id) => `https://pubmed.ncbi.nlm.nih.gov/${id}/`)],
    ["Contributors", data.contributors.join(", ")],
  ];

  // Summary and design clamped to 3 lines, "Show more" only when the clamped text overflows
  let summary!: HTMLParagraphElement;
  let design: HTMLParagraphElement | undefined;
  const [clamped, setClamped] = createSignal(true);
  const [overflows, setOverflows] = createSignal(false);
  onMount(() =>
    requestAnimationFrame(() => setOverflows([summary, design].some((e) => e && e.scrollHeight > e.clientHeight + 2))),
  );

  // Table state: filter text, sorted column (`selected` sorts by selection), accessions of the selected samples
  const [filter, setFilter] = createSignal("");
  const [sort, setSort] = createSignal({ col: "accession", dir: 1 });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [prompt, setPrompt] = createSignal("");

  // Samples matching the filter, sorted. The selection is read untracked so a clicked row stays in place when sorted
  // by selection, the sort and "select all" re-sort the rows
  const shown = createMemo(() => {
    const text = filter().toLowerCase();
    const { col, dir } = sort();
    const list = data.samples.filter(
      (s) =>
        !text ||
        [s.accession, s.title, s.source, s.description, ...Object.values(s.characteristics)]
          .join(" ")
          .toLowerCase()
          .includes(text),
    );
    const sel = untrack(selected);
    const key =
      col === "selected"
        ? (s: GeoSample) => (sel.has(s.accession) ? "0" : "1")
        : (columns.find((c) => c.key === col)?.get ?? (() => ""));
    return list.sort((a, b) => collator.compare(key(a) ?? "", key(b) ?? "") * dir);
  });
  const allShownSelected = () => shown().length > 0 && shown().every((s) => selected().has(s.accession));
  const selectedSamples = () => data.samples.filter((s) => selected().has(s.accession));
  // Click a header to sort by its column, again to reverse
  const sortBy = (col: string) => setSort({ col, dir: sort().col === col ? -sort().dir : 1 });
  const dirOf = (col: string) => (sort().col === col ? (sort().dir > 0 ? "asc" : "desc") : undefined);

  /** Selected samples, told to the model with the next message */
  function select(next: ReadonlySet<string>) {
    setSelected(next);
    const list = selectedSamples();
    const describe = (s: GeoSample) =>
      `${s.accession} (${[s.title, ...Object.entries(s.characteristics).map(([k, v]) => `${k}: ${v}`)].join("; ")})`;
    void mcp.updateContext(
      list.length
        ? `The user selected ${list.length} sample${list.length > 1 ? "s" : ""} of GEO Series ${data.accession}: ${list.map(describe).join(", ")}`
        : `The user has not selected samples of GEO Series ${data.accession}`,
    );
  }

  function toggle(acc: string) {
    const next = new Set(selected());
    if (next.has(acc)) next.delete(acc);
    else next.add(acc);
    select(next);
  }

  function selectAllShown(e: MouseEvent & { currentTarget: HTMLInputElement }) {
    // The checkbox does not sort its column
    e.stopPropagation();
    const checked = e.currentTarget.checked;
    const next = new Set(selected());
    for (const s of shown()) {
      if (checked) next.add(s.accession);
      else next.delete(s.accession);
    }
    select(next);
    setSort((s) => ({ ...s }));
    // Unchecked again when no sample is shown
    e.currentTarget.checked = allShownSelected();
  }

  function send() {
    const text = prompt().trim() || `Compare these samples of ${data.accession}`;
    void mcp.sendMessage(
      `${text}: ${selectedSamples()
        .map((s) => `${s.accession} (${s.title})`)
        .join(", ")}`,
    );
    setPrompt("");
  }

  return (
    <>
      <header>
        <h1>
          <span class="acc">{data.accession}</span>
          {data.title}
        </h1>
        <button type="button" class="logo-link" title="Open in GEO" onClick={() => mcp.openLink(data.url)}>
          <Logo name="GEO" />
        </button>
        <FullscreenButton mcp={mcp} />
      </header>
      <div class="meta">
        <For each={meta.filter(([, v]) => v)}>
          {([k, v]) => (
            <span>
              <b>{k}</b>
              {v}
            </span>
          )}
        </For>
      </div>
      <p class="text" classList={{ clamp: clamped() }} ref={summary}>
        <b>Summary.</b> {data.summary}
      </p>
      <Show when={data.design}>
        <p class="text" classList={{ clamp: clamped() }} ref={design}>
          <b>Overall design.</b> {data.design}
        </p>
      </Show>
      <Show when={overflows()}>
        <a onClick={() => setClamped(!clamped())}>{clamped() ? "Show more" : "Show less"}</a>
      </Show>

      <h2>
        Samples{" "}
        <span class="muted">
          {shown().length === data.samples.length
            ? `${data.sample_count}`
            : `${shown().length} of ${data.samples.length}`}
        </span>
      </h2>
      <div class="chips">
        <Show when={shared.length}>
          <span class="muted">All samples:</span>
          <For each={shared}>
            {([k, v]) => (
              <span class="chip" title={v}>
                <i>{k}:</i> {v.length > 80 ? v.slice(0, 77) + "..." : v}
              </span>
            )}
          </For>
        </Show>
      </div>
      <Show when={data.samples_note}>
        <div class="note">{data.samples_note}</div>
      </Show>
      <div class="toolbar">
        <input
          type="search"
          placeholder="Filter samples by accession, title, characteristics"
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <div class="scroll samples">
        <table>
          <thead>
            <tr>
              <th data-dir={dirOf("selected")} onClick={() => sortBy("selected")}>
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allShownSelected()}
                  onClick={selectAllShown}
                />
              </th>
              <For each={columns}>
                {(c) => (
                  <th data-dir={dirOf(c.key)} onClick={() => sortBy(c.key)}>
                    {c.label[0].toUpperCase() + c.label.slice(1)}
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For
              each={shown()}
              fallback={
                <tr>
                  <td colspan={columns.length + 1} class="muted">
                    No sample matches the filter
                  </td>
                </tr>
              }
            >
              {(s) => (
                <tr class={selected().has(s.accession) ? "selected" : ""} onClick={() => toggle(s.accession)}>
                  <td>
                    <input type="checkbox" checked={selected().has(s.accession)} aria-label={`Select ${s.accession}`} />
                  </td>
                  <For each={columns}>
                    {(c) =>
                      c.key === "accession" ? (
                        <td>
                          {/* Opens the sample without selecting it */}
                          <a
                            onClick={(e) => {
                              e.stopPropagation();
                              mcp.openLink(geoUrl(s.accession));
                            }}
                          >
                            {s.accession}
                          </a>
                        </td>
                      ) : (
                        <td class={c.key === "title" || c.key === "description" ? "wrap" : ""}>{c.get(s) ?? ""}</td>
                      )
                    }
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="selection">
        <span class="muted">{selectedSamples().length ? `${selectedSamples().length} selected` : "No selection"}</span>
        <input
          placeholder="Compare these samples"
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && selectedSamples().length) send();
          }}
        />
        <button type="button" class="primary" disabled={!selectedSamples().length} onClick={send}>
          Send
        </button>
      </div>

      <h2>
        Supplementary files <span class="muted">{data.files.length ? `${data.files.length}` : ""}</span>
      </h2>
      <Show when={data.files_note}>
        <div class="note">{data.files_note}</div>
      </Show>
      <Show when={data.files.length}>
        <div class="scroll files">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Modified</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={data.files}>
                {(f) => (
                  <tr>
                    <td>
                      <a onClick={() => mcp.openLink(f.url)}>{f.name}</a>
                    </td>
                    <td class="num">{f.size ?? (f.directory ? "folder" : "")}</td>
                    <td class="muted">{f.modified ?? ""}</td>
                    <td>
                      <button type="button" onClick={() => mcp.openLink(f.url)}>
                        {f.directory ? "Open" : "Download"}
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  header h1 {
    flex: 1 1 320px;
    line-height: 1.35;
  }
  header .acc {
    color: var(--accent);
    margin-right: 6px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 12px;
    margin-bottom: 8px;
  }
  .meta b {
    color: var(--muted);
    font-weight: 500;
    margin-right: 4px;
  }
  .text {
    margin: 0 0 6px;
    white-space: pre-line;
  }
  .text.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .text b {
    font-weight: 600;
  }
  h2 {
    font-size: 13px;
    font-weight: 600;
    margin: 14px 0 6px;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  h2 .muted {
    font-weight: 400;
    font-size: 12px;
  }
  .toolbar {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .toolbar input {
    flex: 1;
    min-width: 140px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
    font-size: 12px;
  }
  .chip {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 8px;
  }
  .chip i {
    font-style: normal;
    color: var(--muted);
  }
  .scroll {
    max-height: 360px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  :root[data-mode="fullscreen"] .scroll.samples {
    max-height: calc(100vh - 380px);
    min-height: 200px;
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
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  td.wrap {
    white-space: normal;
    min-width: 160px;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--panel);
    cursor: pointer;
    user-select: none;
    z-index: 1;
    font-weight: 600;
  }
  th[data-dir="asc"]::after {
    content: " \25B2";
  }
  th[data-dir="desc"]::after {
    content: " \25BC";
  }
  .samples tbody tr {
    cursor: pointer;
  }
  tbody tr:hover,
  tr.selected {
    background: var(--hover);
  }
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
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
  .note {
    font-size: 12px;
    color: var(--muted);
    margin: 4px 0;
  }
  .files td:first-child {
    white-space: normal;
    word-break: break-all;
  }
  .files button {
    padding: 1px 8px;
    font-size: 12px;
  }
`;
