// Card of a gene from MyGene.info: summary, location on the karyotype, gene structure, GO terms and orthologs
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createMcpApp, type McpApp } from "./lib/mcp-app.tsx";
import { Logo } from "./lib/logos.tsx";
import { css } from "./lib/styles.ts";

interface Location {
  chr: string;
  start: number;
  end: number;
  strand: number;
  band: string | null;
  assembly: string | null;
}

/** Exons as [start, end], coding part between `cdsStart` and `cdsEnd` */
interface Transcript {
  id: string;
  start: number;
  end: number;
  cdsStart: number | null;
  cdsEnd: number | null;
  exons: [number, number][];
}

interface GoTerm {
  id: string;
  term: string;
  evidence: string[];
  experimental: boolean;
  qualifier: string | null;
}

interface Ortholog {
  taxid: number;
  species: string;
  commonName: string | null;
  geneId: string;
  symbol: string | null;
  name: string | null;
}

interface Link {
  name: string;
  id: string;
  url: string;
}

/** `structuredContent` of the `show_gene_card` tool */
interface GeneCardData {
  id: string;
  symbol: string;
  name: string | null;
  taxid: number | null;
  species: string | null;
  commonName: string | null;
  type: string | null;
  aliases: string[];
  otherNames: string[];
  summary: string | null;
  location: Location | null;
  /** Chromosome name: [length, centromere], for human and mouse */
  karyotype: Record<string, [number, number | null]> | null;
  /** Representative transcript, the RefSeq one with the most exons */
  transcript: Transcript | null;
  transcripts: number;
  go: Record<string, GoTerm[]>;
  /** Number of pathways per source */
  pathways: Record<string, number>;
  orthologs: Ortholog[];
  links: Link[];
}

const ASPECTS = { BP: "Biological process", MF: "Molecular function", CC: "Cellular component" };
const PATHWAYS: Record<string, string> = {
  kegg: "KEGG",
  reactome: "Reactome",
  wikipathways: "WikiPathways",
  biocarta: "BioCarta",
  pid: "PID",
  smpdb: "SMPDB",
  netpath: "NetPath",
  humancyc: "HumanCyc",
  yeastcyc: "YeastCyc",
  mousecyc: "MouseCyc",
};
const KARYOTYPE_HEIGHT = 90;

const mb = (bp: number) => `${(bp / 1e6).toFixed(bp < 1e7 ? 2 : 1)} Mb`;
const kb = (bp: number) => (bp >= 1000 ? `${(bp / 1000).toFixed(1)} kb` : `${bp} bp`);
const fmt = (n: number) => n.toLocaleString("en-US");

export default function Widget() {
  const mcp = createMcpApp<GeneCardData>("MyGene card", "show_gene_card");
  return (
    <Show
      when={mcp.data()?.symbol ? mcp.data() : undefined}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading the gene" : "No gene"}</h1>
        </header>
      }
    >
      {(data) => <GeneCard data={data} mcp={mcp} />}
    </Show>
  );
}

function GeneCard(props: { data: GeneCardData; mcp: McpApp<GeneCardData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const species = data.commonName ? `${data.species} (${data.commonName})` : data.species;
  const pathways = Object.entries(data.pathways);
  const [summaryOpen, setSummaryOpen] = createSignal(false);

  return (
    <>
      <header>
        <h1>
          {data.symbol} <span class="sub">{data.name ?? ""}</span>
        </h1>
        <span class="muted">
          <span class="species">{species ?? ""}</span> · {data.type ?? ""}
        </span>
        <span class="spacer" />
        <div class="links">
          <For each={data.links}>
            {(l) => (
              <a class="logo-link" title={`${l.name} ${l.id}`} onClick={() => mcp.openLink(l.url)}>
                <Logo name={l.name} />
              </a>
            )}
          </For>
        </div>
      </header>

      <div class="grid">
        <section class="wide">
          <h2>Summary</h2>
          <Show when={data.summary} fallback={<div class="empty">No RefSeq summary</div>}>
            <p
              class="summary"
              classList={{ open: summaryOpen() }}
              title="Click to expand"
              onClick={() => setSummaryOpen(!summaryOpen())}
            >
              {data.summary}
            </p>
          </Show>
          <div class="chips">
            <Show when={data.aliases.length}>
              <span>
                Aliases <b>{data.aliases.join(", ")}</b>
              </span>
            </Show>
            <Show when={pathways.length}>
              <span>Pathways</span>
              <For each={pathways}>
                {([k, n]) => (
                  <span>
                    <b>{n}</b> {PATHWAYS[k] ?? k}
                  </span>
                )}
              </For>
            </Show>
          </div>
        </section>
        <LocationSection data={data} />
        <GoSection data={data} mcp={mcp} />
        <OrthologsSection data={data} mcp={mcp} />
      </div>

      <div class="actions">
        <button
          type="button"
          class="primary"
          onClick={() =>
            void mcp.sendMessage(
              `What are the main functions of ${data.symbol} (${data.species}) and its role in disease?`,
            )
          }
        >
          Ask about {data.symbol}
        </button>
      </div>
    </>
  );
}

/** Location and structure, the drawings follow the width of the section */
function LocationSection(props: { data: GeneCardData }) {
  const { data } = props;
  const loc = data.location;
  if (!loc)
    return (
      <section class="wide">
        <h2>Location</h2>
        <div class="empty">No genomic position</div>
      </section>
    );
  const t = data.transcript;
  const chrom = data.karyotype?.[loc.chr];

  let drawings!: HTMLDivElement;
  const [width, setWidth] = createSignal(0);
  onMount(() => {
    const onResize = () => setWidth(Math.floor(drawings.clientWidth));
    onResize();
    const observer = new ResizeObserver(onResize);
    observer.observe(drawings);
    onCleanup(() => observer.disconnect());
  });

  return (
    <section class="wide">
      <h2>
        Location <span>chromosome {loc.chr}</span>
      </h2>
      <div class="facts">
        <span>
          Position{" "}
          <b>
            chr{loc.chr}:{fmt(loc.start)}-{fmt(loc.end)}
          </b>
        </span>
        <span>
          Strand <b>{loc.strand < 0 ? "minus (-)" : "plus (+)"}</b>
        </span>
        <span>
          Length <b>{kb(loc.end - loc.start)}</b>
        </span>
        <Show when={loc.band}>
          {(band) => (
            <span>
              Band <b>{band().replaceAll("|", " · ")}</b>
            </span>
          )}
        </Show>
        <Show when={loc.assembly}>
          <span>
            Assembly <b>{loc.assembly}</b>
          </span>
        </Show>
      </div>
      <div class="drawings" ref={drawings}>
        <Show when={chrom && width()}>
          <div class="karyo">
            <Karyotype karyotype={data.karyotype!} loc={loc} width={Math.min(width(), 820)} />
          </div>
          <Chromosome length={chrom![0]} centromere={chrom![1]} loc={loc} width={width()} />
        </Show>
      </div>
      <Show when={t}>
        {(t) => (
          <>
            <h2 class="sub-h">
              Gene structure{" "}
              <span>
                {t().id} · {t().exons.length} exons ·{" "}
                {t().cdsStart != null ? `coding ${kb(t().cdsEnd! - t().cdsStart!)} (genomic)` : "non coding"} ·{" "}
                {data.transcripts} transcript{data.transcripts > 1 ? "s" : ""} in total
              </span>
            </h2>
            <div>
              <Show when={width()}>
                <Structure transcript={t()} strand={loc.strand} width={width()} />
              </Show>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

/** All chromosomes as vertical bars scaled by length, the gene chromosome highlighted with a marker */
function Karyotype(props: { karyotype: Record<string, [number, number | null]>; loc: Location; width: number }) {
  const names = Object.keys(props.karyotype);
  const max = Math.max(...names.map((c) => props.karyotype[c][0]));
  const step = () => Math.min(34, props.width / names.length);
  const H = KARYOTYPE_HEIGHT;
  return (
    <svg viewBox={`0 -8 ${props.width} ${H + 24}`} width={props.width} role="img" aria-label="Karyotype">
      <For each={names}>
        {(c, i) => {
          const [len, cen] = props.karyotype[c];
          const h = (len / max) * H;
          const x = () => i() * step() + step() / 2 - 4;
          const active = c === props.loc.chr;
          const markY = ((props.loc.start + props.loc.end) / 2 / len) * h;
          const cenY = cen ? (cen / len) * h : null;
          return (
            <g>
              <title>
                chr{c} · {mb(len)}
              </title>
              <rect x={x()} y="0" width="8" height={h} rx="4" fill={active ? "var(--accent)" : "var(--chrom)"} />
              {/* Constriction at the centromere */}
              <Show when={cenY != null}>
                <rect x={x() - 1} y={cenY! - 1.5} width="2" height="3" fill="var(--panel)" />
                <rect x={x() + 7} y={cenY! - 1.5} width="2" height="3" fill="var(--panel)" />
              </Show>
              <Show when={active}>
                <line
                  x1={x() - 5}
                  x2={x() + 13}
                  y1={markY}
                  y2={markY}
                  stroke="var(--mark)"
                  stroke-width="3"
                  stroke-linecap="round"
                />
              </Show>
              <text
                x={x() + 4}
                y={H + 12}
                text-anchor="middle"
                class={active ? "strong" : ""}
                style={step() < 22 ? { "font-size": "9px" } : undefined}
              >
                {c}
              </text>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

/** The gene chromosome, horizontal with its arms and ticks, the gene position marked */
function Chromosome(props: { length: number; centromere: number | null; loc: Location; width: number }) {
  const { length: len, centromere: cen, loc } = props;
  const x0 = 2;
  const x1 = () => props.width - 2;
  const x = (p: number) => x0 + (p / len) * (x1() - x0);
  const mid = (loc.start + loc.end) / 2;
  const label = `${loc.band ? `${loc.band.split("|")[0]} · ` : ""}${mb(mid)}`;
  return (
    <svg viewBox={`0 0 ${props.width} 58`} width={props.width} role="img" aria-label={`Chromosome ${loc.chr}`}>
      <Show when={cen} fallback={<rect x={x0} y="22" width={x1() - x0} height="16" rx="8" fill="var(--chrom)" />}>
        {(cen) => (
          <>
            <rect x={x0} y="22" width={x(cen()) - x0 - 2} height="16" rx="8" fill="var(--chrom)" />
            <rect x={x(cen()) + 2} y="22" width={x1() - x(cen()) - 2} height="16" rx="8" fill="var(--chrom)" />
            <text x={(x0 + x(cen())) / 2} y="34" text-anchor="middle">
              p
            </text>
            <text x={(x(cen()) + x1()) / 2} y="34" text-anchor="middle">
              q
            </text>
          </>
        )}
      </Show>
      <For each={[0, 0.25, 0.5, 0.75, 1]}>
        {(f) => (
          <text x={x0 + f * (x1() - x0)} y="54" text-anchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}>
            {mb(f * len)}
          </text>
        )}
      </For>
      <rect
        x={x(loc.start) - 1.5}
        y="18"
        width={Math.max(3, x(loc.end) - x(loc.start))}
        height="24"
        rx="1.5"
        fill="var(--mark)"
      />
      <text x={Math.min(Math.max(x(mid), x0 + 60), x1() - 60)} y="12" text-anchor="middle" class="strong">
        {label}
      </text>
    </svg>
  );
}

/** Exons of the transcript as boxes, coding parts taller, introns as a line with strand chevrons */
function Structure(props: { transcript: Transcript; strand: number; width: number }) {
  const { transcript: t, strand } = props;
  const x0 = 2;
  const x1 = () => props.width - 2;
  const x = (p: number) => x0 + ((p - t.start) / (t.end - t.start || 1)) * (x1() - x0);
  const chevrons = createMemo(() => {
    const out: number[] = [];
    for (let cx = x0 + 20; cx < x1() - 10; cx += 40) out.push(cx);
    return out;
  });
  return (
    <svg viewBox={`0 0 ${props.width} 54`} width={props.width} role="img" aria-label="Gene structure">
      <line x1={x0} x2={x1()} y1="21" y2="21" stroke="var(--muted)" />
      <For each={chevrons()}>
        {(cx) => (
          <path
            d={strand < 0 ? `M${cx + 3} 17 l-4 4 l4 4` : `M${cx - 3} 17 l4 4 l-4 4`}
            fill="none"
            stroke="var(--muted)"
          />
        )}
      </For>
      <For each={t.exons}>
        {([s, e], i) => {
          // Coding part of the exon
          const [cs, ce] = [Math.max(s, t.cdsStart ?? s), Math.min(e, t.cdsEnd ?? e)];
          return (
            <g>
              <title>{`Exon ${strand < 0 ? t.exons.length - i() : i() + 1} · ${fmt(s)}-${fmt(e)} · ${kb(e - s)}`}</title>
              <rect x={x(s)} y="15" width={Math.max(1.5, x(e) - x(s))} height="12" fill="var(--exon)" opacity="0.55" />
              <Show when={t.cdsStart != null && ce > cs}>
                <rect x={x(cs)} y="10" width={Math.max(1.5, x(ce) - x(cs))} height="22" fill="var(--exon)" />
              </Show>
            </g>
          );
        }}
      </For>
      <text x={x0} y="48">
        {fmt(t.start)}
      </text>
      <text x={x1()} y="48" text-anchor="end">
        {fmt(t.end)}
      </text>
      <text x={(x0 + x1()) / 2} y="48" text-anchor="middle">
        {strand < 0 ? "<- minus strand" : "plus strand ->"} · {kb(t.end - t.start)}
      </text>
    </svg>
  );
}

/** GO terms of an aspect, filtered by text and evidence, click a term to ask about it */
function GoSection(props: { data: GeneCardData; mcp: McpApp<GeneCardData> }) {
  const { data, mcp } = props;
  const [aspect, setAspect] = createSignal("BP");
  const [filter, setFilter] = createSignal("");
  const [experimental, setExperimental] = createSignal(false);
  const terms = createMemo(() => {
    const text = filter().toLowerCase();
    return (data.go[aspect()] ?? []).filter(
      (t) => (!experimental() || t.experimental) && (!text || `${t.id} ${t.term}`.toLowerCase().includes(text)),
    );
  });

  return (
    <section>
      <h2>Gene Ontology</h2>
      <div class="tiles">
        <For each={Object.entries(ASPECTS)}>
          {([a, name]) => {
            const aspectTerms = data.go[a] ?? [];
            return (
              <button type="button" classList={{ active: aspect() === a }} onClick={() => setAspect(a)}>
                <b>{aspectTerms.length}</b>
                <span>{name}</span>
                <span>{aspectTerms.filter((t) => t.experimental).length} experimental</span>
              </button>
            );
          }}
        </For>
      </div>
      <div class="go-tools">
        <input type="search" placeholder="Filter terms" onInput={(e) => setFilter(e.currentTarget.value)} />
        <label>
          <input type="checkbox" onChange={(e) => setExperimental(e.currentTarget.checked)} /> Experimental only
        </label>
      </div>
      <div class="terms">
        <For each={terms()} fallback={<div class="empty">No term</div>}>
          {(t) => (
            <div
              title={`${t.id} · ${t.qualifier ?? ""} · click to ask about it`}
              onClick={() => void mcp.sendMessage(`What is the role of ${data.symbol} in ${t.term} (${t.id})?`)}
            >
              <span class="t">{t.term}</span>
              <span class="ev" classList={{ exp: t.experimental }}>
                {t.evidence.join(" ")}
              </span>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}

function OrthologsSection(props: { data: GeneCardData; mcp: McpApp<GeneCardData> }) {
  const { data, mcp } = props;
  return (
    <section>
      <Show
        when={data.orthologs.length}
        fallback={
          <>
            <h2>Orthologs</h2>
            <div class="empty">No HomoloGene ortholog</div>
          </>
        }
      >
        <h2>
          Orthologs <span>HomoloGene</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>Species</th>
              <th>Gene</th>
              <th>Name</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={data.orthologs}>
              {(o) => (
                <tr>
                  <td>
                    <span class="species">{o.species}</span>
                    <Show when={o.commonName}>
                      {" "}
                      <span class="muted">{o.commonName}</span>
                    </Show>
                  </td>
                  <td>
                    <a onClick={() => mcp.openLink(`https://www.ncbi.nlm.nih.gov/gene/${o.geneId}`)}>
                      {o.symbol ?? o.geneId}
                    </a>
                  </td>
                  <td>{o.name ?? ""}</td>
                  <td>
                    <button
                      type="button"
                      title="Show its gene card"
                      onClick={() =>
                        void mcp.sendMessage(
                          `Show the gene card of ${o.symbol ?? o.geneId} (Entrez ${o.geneId}, ${o.species})`,
                        )
                      }
                    >
                      Card
                    </button>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  :root {
    --chrom: #d8dee4;
    --exon: #4c8bf5;
    --mark: #e5484d;
  }
  :root[data-theme="dark"] {
    --chrom: #30363d;
    --mark: #ff6369;
  }
  h1 .sub {
    font-weight: 400;
    color: var(--muted);
  }
  .species {
    font-style: italic;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
    gap: 10px;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--panel);
    min-width: 0;
  }
  section.wide {
    grid-column: 1 / -1;
  }
  section h2 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  section h2 span {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .summary {
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .summary.open {
    display: block;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .chips b {
    color: var(--fg);
    font-weight: 600;
  }
  svg {
    display: block;
    overflow: visible;
  }
  svg text {
    fill: var(--muted);
    font: 11px var(--font-sans, system-ui, sans-serif);
  }
  .drawings {
    margin-top: 10px;
  }
  .karyo {
    margin-bottom: 4px;
    display: flex;
    justify-content: center;
  }
  h2.sub-h {
    margin-top: 12px;
  }
  svg text.strong {
    fill: var(--fg);
    font-weight: 600;
  }
  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 12px;
    margin-top: 4px;
  }
  .facts span {
    color: var(--muted);
  }
  .facts b {
    color: var(--fg);
    font-weight: 500;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 8px;
  }
  .tiles button {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 6px 8px;
    text-align: left;
    border-radius: 6px;
  }
  .tiles button.active {
    border-color: var(--accent);
    background: var(--hover);
  }
  .tiles b {
    font-size: 18px;
    line-height: 1.1;
  }
  .tiles span {
    font-size: 11px;
    color: var(--muted);
  }
  .go-tools {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .go-tools input[type="search"] {
    flex: 1;
    min-width: 0;
    padding: 2px 8px;
  }
  .go-tools label {
    display: flex;
    gap: 4px;
    align-items: center;
    white-space: nowrap;
  }
  .terms {
    max-height: 230px;
    overflow-y: auto;
    font-size: 12px;
  }
  .terms div {
    display: flex;
    gap: 8px;
    padding: 2px 0;
    border-top: 1px solid var(--border);
    cursor: pointer;
  }
  .terms div:hover {
    background: var(--hover);
  }
  .terms .t {
    flex: 1;
    min-width: 0;
  }
  .terms .ev {
    color: var(--muted);
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    white-space: nowrap;
  }
  .terms .exp {
    color: var(--accent);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  td,
  th {
    text-align: left;
    padding: 3px 6px 3px 0;
    border-top: 1px solid var(--border);
  }
  th {
    color: var(--muted);
    font-weight: 500;
    border-top: 0;
  }
  td button {
    font-size: 11px;
    padding: 0 6px;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
`;
