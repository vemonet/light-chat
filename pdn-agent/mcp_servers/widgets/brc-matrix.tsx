// Matrix of the genome assemblies of BRC Analytics against the analysis workflows they can run
import { createMemo, createSignal, For, Show } from "solid-js";
import { Logo } from "./lib/logos.tsx";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";
import { css } from "./lib/styles.ts";

interface BrcOrganism {
  taxonomyId: string;
  species: string;
  assemblyCount: number;
}

interface BrcAssembly {
  accession: string;
  species: string;
  strain: string | null;
  taxonomyId: string;
  organismTaxonomyId: string;
  level: string | null;
  ploidy: string[];
  isRef: boolean;
  length: number | null;
  gcPercent: number | null;
  scaffolds: number | null;
  geneModel: boolean;
  ucscUrl: string | null;
}

interface BrcWorkflow {
  iwcId: string;
  name: string;
  description: string;
  categories: string[];
  ploidy: string | null;
  /** Taxon the workflow is restricted to, assemblies must descend from it */
  taxonomyId: string | null;
  trsId: string;
  /** e.g. "Paired-end reads (WGS)", "Gene model (GTF)" */
  inputs: string[];
}

/** Compatible (`ready`, or `no_gene_model` when the workflow needs one), or the mismatch */
type Status = "ready" | "no_gene_model" | "ploidy" | "taxonomy";

/** `structuredContent` of the `show_brc_workflow_matrix` tool */
interface BrcMatrixData {
  query: string;
  organisms: BrcOrganism[];
  assemblies: BrcAssembly[];
  assemblyTotal: number;
  workflows: BrcWorkflow[];
  /** In the catalog order */
  categories: { name: string; description: string }[];
  /** Accession -> status of each workflow, in the order of `workflows` */
  status: Record<string, Status[]>;
}

type Selection =
  | { kind: "cell"; a: BrcAssembly; w: BrcWorkflow }
  | { kind: "assembly"; a: BrcAssembly }
  | { kind: "workflow"; w: BrcWorkflow };

const SITE = "https://brc-analytics.org";
const PALETTE = ["#2e86c1", "#27ae60", "#8e44ad", "#d35400", "#c0392b", "#16a085", "#b7950b", "#5d6d7e"];
// Names of the taxa workflows are restricted to, others are shown by ID
const TAXA: Record<string, string> = {
  2: "Bacteria",
  2759: "Eukaryota",
  10239: "Viruses",
  131567: "cellular organisms",
};
const STATUS: Record<Status, [string, string]> = {
  ready: ["ok", "Compatible, ready to run"],
  no_gene_model: ["warn", "Compatible, but needs a gene model (GTF) this assembly does not have"],
  ploidy: ["no", "Not compatible: ploidy mismatch"],
  taxonomy: ["no", "Not compatible: taxonomy mismatch"],
};

const entity = (acc: string) => acc.replace(/\./g, "_");
const trs = (id: string) => id.replace(/^#/, "").replace(/[^a-zA-Z0-9]/g, "-");
const urls = {
  assembly: (a: BrcAssembly) => `${SITE}/data/assemblies/${entity(a.accession)}`,
  organism: (taxid: string) => `${SITE}/data/organisms/${taxid}`,
  workflow: (w: BrcWorkflow) => `${SITE}/data/workflows/${trs(w.trsId)}`,
  configure: (a: BrcAssembly, w: BrcWorkflow) =>
    `${SITE}/data/assemblies/${entity(a.accession)}/analyze/workflows?trsId=${encodeURIComponent(trs(w.trsId))}`,
  ncbi: (a: BrcAssembly) => `https://www.ncbi.nlm.nih.gov/datasets/genome/${a.accession}/`,
};
const label = (a: BrcAssembly) => [a.species, a.strain].filter(Boolean).join(" ");
const taxon = (id: string | null) => (id && TAXA[id] ? `${TAXA[id]} (taxon ${id})` : `NCBI taxon ${id}`);
const firstCategory = (w: BrcWorkflow) => w.categories[0] ?? "Other";
const mb = (n: number | null) => (n ? `${(n / 1e6).toFixed(2)} Mb` : "");

export default function Widget() {
  const mcp = createMcpApp<BrcMatrixData>("BRC Analytics workflow matrix", "show_brc_workflow_matrix");
  // A new tool result recreates the matrix, which resets the filters and selection
  return (
    <Show
      when={mcp.data()?.workflows && mcp.data()}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading workflows" : "No workflows"}</h1>
        </header>
      }
    >
      {(data) => <Matrix data={data} mcp={mcp} />}
    </Show>
  );
}

function Matrix(props: { data: BrcMatrixData; mcp: McpApp<BrcMatrixData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const index = new Map(data.workflows.map((w, i) => [w, i]));
  const st = (a: BrcAssembly, w: BrcWorkflow) => data.status[a.accession][index.get(w)!];
  const runnable = new Set(
    data.workflows.filter((w) => data.assemblies.some((a) => ["ready", "no_gene_model"].includes(st(a, w)))),
  );
  const colors = Object.fromEntries(data.categories.map((c, i) => [c.name, PALETTE[i % PALETTE.length]]));
  const order = data.categories.map((c) => c.name);
  const species = data.organisms.map((o) => o.species);
  // Row name: the strain, with the species when several are shown
  const name = (a: BrcAssembly) => (data.organisms.length > 1 ? label(a) : a.strain || a.species);
  const reason = (a: BrcAssembly, w: BrcWorkflow) => {
    const s = st(a, w);
    if (s === "ploidy")
      return `workflow requires ${w.ploidy} genomes, the assembly is ${a.ploidy.join(", ") || "of unknown ploidy"}`;
    return s === "taxonomy" ? `workflow restricted to ${taxon(w.taxonomyId)}` : "";
  };

  // Options of the toolbar, the workflow column under the pointer, the selection shown in the details
  const [text, setText] = createSignal("");
  const [category, setCategory] = createSignal("");
  const [hide, setHide] = createSignal(true);
  const [hovered, setHovered] = createSignal<BrcWorkflow>();
  const [selected, setSelected] = createSignal<Selection>();

  // Assemblies matching the filter, workflows of the category, grouped by category in the catalog order
  const group = (w: BrcWorkflow) => category() || firstCategory(w);
  const assemblies = createMemo(() => {
    const needle = text().toLowerCase();
    return data.assemblies.filter(
      (a) => !needle || `${a.accession} ${a.species} ${a.strain ?? ""} ${a.level ?? ""}`.toLowerCase().includes(needle),
    );
  });
  const workflows = createMemo(() =>
    data.workflows
      .filter((w) => (!category() || w.categories.includes(category())) && (!hide() || runnable.has(w)))
      .sort((a, b) => order.indexOf(group(a)) - order.indexOf(group(b))),
  );
  // Category bands: consecutive workflows of the same group
  const bands = createMemo(() => {
    const bands: { name: string; n: number }[] = [];
    for (const w of workflows()) {
      const last = bands.at(-1);
      if (last?.name === group(w)) last.n++;
      else bands.push({ name: group(w), n: 1 });
    }
    return bands;
  });

  const isSelected = (a?: BrcAssembly, w?: BrcWorkflow) => {
    const s = selected();
    if (!s) return false;
    if (s.kind === "cell") return s.a === a && s.w === w;
    return s.kind === "assembly" ? !w && s.a === a : !a && s.w === w;
  };

  /** Selection shown in the details, also told to the model */
  function select(s: Selection) {
    setSelected(s);
    if (s.kind === "cell") {
      const { a, w } = s;
      void mcp.updateContext(
        `The user selected the BRC Analytics workflow "${w.name}" (${w.iwcId}) on assembly ${a.accession} ` +
          `(${label(a)}): ${STATUS[st(a, w)][1]}${reason(a, w) ? `, ${reason(a, w)}` : ""}`,
      );
    } else if (s.kind === "assembly") {
      const { a } = s;
      const ready = data.workflows.filter((x) => st(a, x) === "ready");
      void mcp.updateContext(
        `The user selected the BRC Analytics assembly ${a.accession} (${label(a)}, ${String(a.level)}` +
          `${a.isRef ? ", reference" : ""}), ready to run ${ready.length} workflows`,
      );
    } else {
      const ok = data.assemblies.filter((x) => st(x, s.w) === "ready");
      void mcp.updateContext(
        `The user selected the BRC Analytics workflow "${s.w.name}" (${s.w.iwcId}), ready on ${ok.length} assemblies`,
      );
    }
  }

  const link = (url: string, text: string) => <a onClick={() => mcp.openLink(url)}>{text}</a>;
  const ref = () => <span class="ref">REF</span>;

  // Contents of the details box for each kind of selection
  function cellDetails(a: BrcAssembly, w: BrcWorkflow) {
    const s = st(a, w);
    const [cls, text] = STATUS[s];
    const compatible = s === "ready" || s === "no_gene_model";
    return (
      <>
        <div>
          <b>{w.name}</b> on <b>{a.accession}</b> <span class="muted">{label(a)}</span>
        </div>
        <div class={cls}>
          {text}
          {reason(a, w) ? `: ${reason(a, w)}` : ""}
        </div>
        <dl>
          <dt>Inputs</dt>
          <dd>{w.inputs.join(", ") || "-"}</dd>
          <dt>Category</dt>
          <dd>{w.categories.join(", ")}</dd>
        </dl>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onClick={() =>
              void mcp.sendMessage(
                compatible
                  ? `How do I run the BRC Analytics workflow "${w.name}" (${w.iwcId}) on the ${label(a)} assembly ` +
                      `${a.accession}? Which sequencing data can I use as input?`
                  : `The BRC Analytics workflow "${w.name}" (${w.iwcId}) is not compatible with the ${label(a)} ` +
                      `assembly ${a.accession} (${reason(a, w)}). Which workflow can I use instead?`,
              )
            }
          >
            {compatible ? "Ask how to run it" : "Ask about alternatives"}
          </button>
          <Show when={compatible}>
            <button type="button" onClick={() => mcp.openLink(urls.configure(a, w))}>
              Configure on BRC Analytics
            </button>
          </Show>
          <button type="button" onClick={() => mcp.openLink(urls.workflow(w))}>
            Workflow page
          </button>
        </div>
      </>
    );
  }

  function assemblyDetails(a: BrcAssembly) {
    const ready = data.workflows.filter((x) => st(a, x) === "ready");
    const links: [string, string][] = [
      [urls.assembly(a), "BRC Analytics"],
      [urls.ncbi(a), "NCBI"],
    ];
    if (a.ucscUrl) links.push([a.ucscUrl, "UCSC browser"]);
    return (
      <>
        <div>
          <b>{label(a)}</b> {link(urls.assembly(a), a.accession)}
          {a.isRef && ref()}
        </div>
        <dl>
          <dt>Level</dt>
          <dd>{a.level ?? "-"}</dd>
          <dt>Size</dt>
          <dd>
            {mb(a.length)}
            {a.gcPercent ? ` · GC ${a.gcPercent}%` : ""}
            {a.scaffolds ? ` · ${a.scaffolds} scaffolds` : ""}
          </dd>
          <dt>Ploidy</dt>
          <dd>{a.ploidy.join(", ") || "-"}</dd>
          <dt>Gene model</dt>
          <dd>{a.geneModel ? "Yes" : "No"}</dd>
          <dt>Taxonomy</dt>
          <dd>{link(`https://www.ncbi.nlm.nih.gov/Taxonomy/Browser/wwwtax.cgi?id=${a.taxonomyId}`, a.taxonomyId)}</dd>
          <dt>Ready</dt>
          <dd>
            {ready.length} workflows: {ready.map((x) => x.name).join(", ") || "none"}
          </dd>
          <dt>Links</dt>
          <dd>
            <For each={links}>
              {([url, text], i) => (
                <>
                  {i() ? " · " : ""}
                  {link(url, text)}
                </>
              )}
            </For>
          </dd>
        </dl>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onClick={() =>
              void mcp.sendMessage(
                `Which analyses can I run on the ${label(a)} assembly ${a.accession} in BRC Analytics, and with ` +
                  `which data?`,
              )
            }
          >
            Ask about it
          </button>
        </div>
      </>
    );
  }

  function workflowDetails(w: BrcWorkflow) {
    const ok = data.assemblies.filter((x) => st(x, w) === "ready");
    const restriction = [
      w.ploidy && w.ploidy !== "ANY" ? `${w.ploidy} genomes` : "",
      w.taxonomyId ? taxon(w.taxonomyId) : "",
    ];
    return (
      <>
        <div>
          <b>{w.name}</b> <span class="muted">{w.categories.join(", ")}</span>
        </div>
        <div>{w.description}</div>
        <dl>
          <dt>Inputs</dt>
          <dd>{w.inputs.join(", ") || "-"}</dd>
          <dt>Restricted to</dt>
          <dd>{restriction.filter(Boolean).join(", ") || "any genome"}</dd>
          <dt>Ready on</dt>
          <dd>
            {ok.length} of {data.assemblies.length} assemblies
          </dd>
        </dl>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onClick={() =>
              void mcp.sendMessage(
                `What does the BRC Analytics workflow "${w.name}" (${w.iwcId}) do, and on which ` +
                  `${data.organisms.map((o) => o.species).join(", ")} assemblies can I run it?`,
              )
            }
          >
            Ask about it
          </button>
          <button type="button" onClick={() => mcp.openLink(urls.workflow(w))}>
            Workflow page
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <header>
        <h1>Workflows for {species.length > 2 ? `${data.query} (${species.length} species)` : species.join(", ")}</h1>
        <span class="muted" id="subtitle">
          {data.assemblyTotal} assemblies · {runnable.size} of {data.workflows.length} workflows compatible
        </span>
        <span class="spacer" />
        <button
          type="button"
          class="logo-link"
          title="Open in BRC Analytics"
          onClick={() =>
            mcp.openLink(
              data.organisms.length === 1 ? urls.organism(data.organisms[0].taxonomyId) : `${SITE}/data/organisms`,
            )
          }
        >
          <Logo name="BRC Analytics" />
        </button>
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="toolbar">
        <input
          type="search"
          placeholder="Filter assemblies by accession, strain, species"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <select aria-label="Workflow category" onChange={(e) => setCategory(e.currentTarget.value)}>
          <option value="">All categories</option>
          <For each={data.categories}>{(c) => <option value={c.name}>{c.name}</option>}</For>
        </select>
        <label>
          <input type="checkbox" checked={hide()} onChange={(e) => setHide(e.currentTarget.checked)} /> Hide workflows
          no assembly can run
        </label>
      </div>

      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="asm" rowspan="2">
                {assemblies().length} of {data.assemblyTotal} assemblies
              </th>
              <th class="wf" rowspan="2" title="Workflows ready to run">
                <div class="muted">Ready</div>
              </th>
              <For each={bands()}>
                {(b) => (
                  <th
                    class="cat"
                    colspan={b.n}
                    style={{ background: `color-mix(in srgb, ${colors[b.name]} 22%, var(--bg))` }}
                    title={`${b.name}: ${data.categories.find((c) => c.name === b.name)?.description ?? ""}`}
                  >
                    <span>{b.name}</span>
                  </th>
                )}
              </For>
            </tr>
            <tr>
              <For each={workflows()}>
                {(w) => (
                  <th
                    class="wf"
                    classList={{ off: !runnable.has(w), selected: isSelected(undefined, w), hover: hovered() === w }}
                    title={`${w.name}\n${w.description}`}
                    onClick={() => select({ kind: "workflow", w })}
                  >
                    <div>{w.name}</div>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          {/* The workflow column of the cell under the pointer is highlighted */}
          <tbody onMouseLeave={() => setHovered()}>
            <For
              each={assemblies()}
              fallback={
                <tr>
                  <td class="asm muted" colspan="2" onMouseOver={() => setHovered()}>
                    No assembly matches the filter
                  </td>
                </tr>
              }
            >
              {(a) => (
                <tr>
                  <td
                    class="asm"
                    classList={{ selected: isSelected(a) }}
                    title={`${a.accession} · ${label(a)} · ${a.level ?? ""}`}
                    onClick={() => select({ kind: "assembly", a })}
                    onMouseOver={() => setHovered()}
                  >
                    <div>
                      {name(a)}
                      {a.isRef && ref()}
                    </div>
                    <div class="sub">
                      {a.accession} · {a.level ?? ""}
                    </div>
                  </td>
                  <td class="n" title="Workflows ready to run" onMouseOver={() => setHovered()}>
                    {workflows().filter((w) => st(a, w) === "ready").length}
                  </td>
                  <For each={workflows()}>
                    {(w) => (
                      <td
                        class="cell"
                        classList={{ selected: isSelected(a, w) }}
                        style={{ "--c": colors[group(w)] }}
                        title={`${w.name}\non ${a.accession} (${label(a)})\n${STATUS[st(a, w)][1]}${reason(a, w) ? `: ${reason(a, w)}` : ""}`}
                        onClick={() => select({ kind: "cell", a, w })}
                        onMouseOver={() => setHovered(w)}
                      >
                        <i class={st(a, w)} />
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <div class="legend">
        <span>
          <i style={{ background: "var(--muted)" }} />
          Ready to run
        </span>
        <span>
          <i
            style={{
              border: "2px solid var(--muted)",
              background: "repeating-linear-gradient(45deg, var(--muted) 0 2px, transparent 2px 5px)",
            }}
          />
          Needs a gene model the assembly lacks
        </span>
        <span>
          <i style={{ width: "5px", height: "5px", "border-radius": "50%", background: "var(--border)" }} />
          Not compatible (ploidy or taxonomy)
        </span>
        <span>{ref()} Reference genome</span>
        <For each={data.categories}>
          {(c) => (
            <span>
              <i style={{ background: colors[c.name] }} />
              {c.name}
            </span>
          )}
        </For>
      </div>

      <div class="details" classList={{ muted: !selected() }}>
        <Show when={selected()} keyed fallback="Click a cell, an assembly or a workflow for details">
          {(s) =>
            s.kind === "cell"
              ? cellDetails(s.a, s.w)
              : s.kind === "assembly"
                ? assemblyDetails(s.a)
                : workflowDetails(s.w)
          }
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
    min-width: 140px;
  }
  .toolbar label {
    display: flex;
    gap: 4px;
    align-items: center;
    color: var(--muted);
    font-size: 12px;
  }
  .scroll {
    width: fit-content;
    max-width: 100%;
    max-height: 520px;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  :root[data-mode="fullscreen"] .scroll {
    max-height: calc(100vh - 250px);
  }
  table {
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
  }
  th,
  td {
    padding: 0;
    background: var(--bg);
  }
  thead th {
    position: sticky;
    z-index: 2;
    font-weight: 500;
  }
  thead tr:first-child th {
    top: 0;
    height: 22px;
  }
  thead tr:nth-child(2) th {
    top: 22px;
    border-bottom: 1px solid var(--border);
    vertical-align: bottom;
  }
  /* Category bands above their workflows */
  th.cat {
    font-size: 11px;
    text-align: left;
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 0;
    color: var(--fg);
    border-left: 2px solid var(--bg);
    cursor: default;
  }
  th.cat span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Workflow names written bottom to top */
  th.wf {
    cursor: pointer;
    padding: 6px 0 4px;
  }
  th.wf div {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    margin: 0 auto;
    white-space: nowrap;
    max-height: 170px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  th.wf.off div {
    color: var(--muted);
  }
  th.asm,
  td.asm {
    position: sticky;
    left: 0;
    z-index: 1;
    text-align: left;
    padding: 3px 8px;
    min-width: 230px;
    max-width: 300px;
    border-right: 1px solid var(--border);
  }
  thead th.asm {
    z-index: 3;
    color: var(--muted);
    vertical-align: bottom;
  }
  td.asm {
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    border-bottom: 1px solid var(--border);
  }
  td.asm .sub {
    color: var(--muted);
    font-size: 11px;
  }
  .ref {
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    background: #1a7f37;
    border-radius: 4px;
    padding: 0 4px;
    margin-left: 4px;
  }
  td.n {
    padding: 0 6px;
    color: var(--muted);
    text-align: right;
    border-bottom: 1px solid var(--border);
    min-width: 34px;
  }
  td.cell {
    width: 24px;
    min-width: 24px;
    height: 34px;
    text-align: center;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }
  td.cell i {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    vertical-align: middle;
  }
  td.cell i.ready {
    background: var(--c);
  }
  /* Compatible but the assembly lacks the gene model the workflow needs */
  td.cell i.no_gene_model {
    border: 2px solid var(--c);
    background: repeating-linear-gradient(45deg, var(--c) 0 2px, transparent 2px 5px);
  }
  td.cell i.ploidy,
  td.cell i.taxonomy {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--border);
  }
  tbody tr:hover td,
  td.hover,
  th.hover,
  .selected {
    background-color: var(--hover);
  }
  td.cell.selected {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12px;
    color: var(--muted);
    margin-top: 6px;
  }
  .legend span {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .legend i {
    width: 11px;
    height: 11px;
    border-radius: 2px;
    display: inline-block;
  }
  .details {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-height: 38px;
  }
  .details .ok {
    color: #1a7f37;
  }
  .details .warn {
    color: #9a6700;
  }
  .details .no {
    color: #cf222e;
  }
  :root[data-theme="dark"] .details .ok {
    color: #3fb950;
  }
  :root[data-theme="dark"] .details .warn {
    color: #d29922;
  }
  :root[data-theme="dark"] .details .no {
    color: #f85149;
  }
  .details .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .details dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 1px 10px;
    margin: 4px 0 0;
    font-size: 12px;
  }
  .details dt {
    color: var(--muted);
  }
  .details dd {
    margin: 0;
  }
`;
