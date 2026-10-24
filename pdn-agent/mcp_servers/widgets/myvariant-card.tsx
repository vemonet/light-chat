// Card of a variant from MyVariant.info: location and consequence, ClinVar records, gnomAD allele frequencies and
// missense predictions, with tabs for the other alleles
import { createSignal, For, Show, type Accessor } from "solid-js";
import { createMcpApp, type McpApp } from "./lib/mcp-app.tsx";
import { Logo } from "./lib/logos.tsx";
import { css } from "./lib/styles.ts";

interface ClinvarRecord {
  accession: string;
  significance: string;
  condition: string;
  reviewStatus: string;
  stars: number;
  lastEvaluated: string | null;
  submitters: number | null;
}

interface Clinvar {
  variantId: number | null;
  /** Most reported significance, of the records with a condition */
  significance: string;
  counts: Record<string, number>;
  /** Best review status of the records */
  stars: number;
  records: ClinvarRecord[];
  url: string | null;
}

interface Population {
  code: string;
  name: string;
  af: number;
}

interface Frequencies {
  af: number | null;
  ac: number | null;
  an: number | null;
  hom: number | null;
  populations: Population[];
}

type Level = "damaging" | "uncertain" | "benign";
type GnomadSet = "genome" | "exome";

interface Prediction {
  name: string;
  score: number;
  min: number;
  max: number;
  /** Limits between the levels, from low to high scores */
  thresholds: number[];
  higherIsWorse: boolean;
  level: Level;
  label: string;
}

interface VariantCard {
  id: string;
  assembly: string;
  chrom: string | null;
  pos: number | null;
  ref: string | null;
  alt: string | null;
  hg19: string | null;
  hg38: string | null;
  rsid: string | null;
  gene: string | null;
  type: string | null;
  consequence: string | null;
  impact: string | null;
  hgvsC: string | null;
  hgvsP: string | null;
  transcript: string | null;
  uniprot: string | null;
  clinvar: Clinvar | null;
  /** `genome` and `exome`, when the variant is in gnomAD */
  gnomad: Partial<Record<GnomadSet, Frequencies>>;
  predictions: Prediction[];
  links: Record<string, string>;
}

/** `structuredContent` of the `show_variant_card` tool */
interface VariantCardData {
  query: string;
  /** The variant first, then the other alleles of the same rsID or ClinVar ID */
  variants: VariantCard[];
  note: string | null;
}

const LEVEL_COLORS: Record<Level, string> = {
  damaging: "var(--pathogenic)",
  uncertain: "var(--uncertain)",
  benign: "var(--benign)",
};
const SET_COLORS: Record<GnomadSet, string> = { genome: "var(--genome)", exome: "var(--exome)" };
const MAX_RECORDS = 6;

/** Color of a ClinVar significance */
function sigColor(significance: string | null | undefined) {
  const s = (significance ?? "").toLowerCase();
  if (s.includes("conflicting") || s.includes("uncertain")) return "var(--uncertain)";
  if (s.includes("likely pathogenic")) return "var(--likely)";
  if (s.includes("pathogenic")) return "var(--pathogenic)";
  if (s.includes("benign")) return "var(--benign)";
  return "var(--muted)";
}
/** Allele frequency, readable from 0.5 to 1e-6 */
const fmtAf = (af: number | null | undefined) =>
  af == null ? "-" : af === 0 ? "0" : af >= 0.001 ? af.toPrecision(3) : af.toExponential(2);
const fmtInt = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString("en-US"));
const shortP = (v: VariantCard) => v.hgvsP ?? v.hgvsC ?? (v.ref && v.alt ? `${v.ref}>${v.alt}` : "");

// Black and white stars, as code points to keep the source ASCII
const STAR = String.fromCodePoint(0x2605);
const EMPTY_STAR = String.fromCodePoint(0x2606);

function Stars(props: { n: number }) {
  return (
    <span class="stars" title={`${props.n} of 4 review stars`}>
      {STAR.repeat(props.n)}
      {EMPTY_STAR.repeat(4 - props.n)}
    </span>
  );
}

export default function Widget() {
  const mcp = createMcpApp<VariantCardData>("MyVariant card", "show_variant_card");
  return (
    <Show
      when={mcp.data()?.variants?.length ? mcp.data() : undefined}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading the variant" : "No variant"}</h1>
        </header>
      }
    >
      {(data) => <Card data={data} mcp={mcp} />}
    </Show>
  );
}

function Card(props: { data: VariantCardData; mcp: McpApp<VariantCardData> }) {
  const { data, mcp } = props;
  // Allele shown, all ClinVar records or the first ones
  const [current, setCurrent] = createSignal(0);
  const [allRecords, setAllRecords] = createSignal(false);

  /** Switch to another allele, told to the model */
  function select(i: number) {
    setCurrent(i);
    const v = data.variants[i];
    void mcp.updateContext(
      `The user switched the variant card to ${v.id} (${v.rsid ?? "no rsID"}, ${v.gene ?? ""} ${shortP(v)}): ` +
        `ClinVar ${v.clinvar?.significance ?? "none"}, gnomAD genome AF ${fmtAf(v.gnomad.genome?.af)}`,
    );
  }

  // The whole card is recreated for the allele shown
  return (
    <Show when={data.variants[current()]} keyed>
      {(v) => {
        const label = `${v.gene ?? ""} ${shortP(v)} (${v.rsid ?? v.id})`.trim();
        return (
          <>
            <header>
              <h1>
                {v.gene ?? "Variant"} {shortP(v)}{" "}
                <span class="id">
                  {v.id}
                  {v.rsid ? ` · ${v.rsid}` : ""}
                </span>
              </h1>
              <span class="spacer" />
              <div class="links">
                <For each={Object.entries(v.links)}>
                  {([name, url]) => (
                    <a class="logo-link" title={name} onClick={() => mcp.openLink(url)}>
                      <Logo name={name} />
                    </a>
                  )}
                </For>
              </div>
            </header>

            <div class="tabs">
              <Show when={data.variants.length > 1}>
                <span class="muted" style={{ "align-self": "center" }}>
                  Alleles:
                </span>
                <For each={data.variants}>
                  {(a, i) => (
                    <button type="button" classList={{ active: i() === current() }} onClick={() => select(i())}>
                      {a.id.split(":").at(-1)}
                      <Show when={a.clinvar}>
                        {(cv) => (
                          <>
                            {" "}
                            <span class="badge" style={{ background: sigColor(cv().significance) }}>
                              ClinVar
                            </span>
                          </>
                        )}
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
            <Show when={data.note && current() === 0}>
              <div class="note">{data.note}</div>
            </Show>

            <div class="grid">
              <Summary v={v} mcp={mcp} />
              <ClinvarSection v={v} mcp={mcp} all={allRecords} toggle={() => setAllRecords(!allRecords())} />
              <Gnomad v={v} mcp={mcp} />
              <Predictions v={v} />
            </div>

            <div class="actions">
              <button
                type="button"
                class="primary"
                onClick={() =>
                  void mcp.sendMessage(`What is the clinical and functional impact of the variant ${label}?`)
                }
              >
                Ask about this variant
              </button>
              <Show when={v.gene}>
                {(gene) => (
                  <button
                    type="button"
                    onClick={() =>
                      void mcp.sendMessage(`Which other variants of ${gene()} are pathogenic, and in which diseases?`)
                    }
                  >
                    Other {gene()} variants
                  </button>
                )}
              </Show>
            </div>
          </>
        );
      }}
    </Show>
  );
}

function Summary(props: { v: VariantCard; mcp: McpApp<VariantCardData> }) {
  const { v, mcp } = props;
  return (
    <section>
      <h2>Variant</h2>
      <dl>
        <dt>Location</dt>
        <dd>
          chr{v.chrom}:{v.pos ?? "?"} <span class="muted">({v.assembly}, VCF)</span>
        </dd>
        <dt>GRCh38 / hg19</dt>
        <dd>
          {v.hg38 ?? "-"} / {v.hg19 ?? "-"}
        </dd>
        <dt>Ref / Alt</dt>
        <dd>
          <span class="mono">
            {v.ref ?? "-"} / {v.alt ?? "-"}
          </span>
        </dd>
        <dt>Type</dt>
        <dd>{v.type ?? "-"}</dd>
        <dt>Consequence</dt>
        <dd>
          {v.consequence ?? "-"}
          <Show when={v.impact}>
            {(impact) => (
              <>
                {" "}
                <span class="muted">· {impact().toLowerCase()} impact</span>
              </>
            )}
          </Show>
        </dd>
        <dt>HGVS</dt>
        <dd>
          <span class="mono">{[v.hgvsC, v.hgvsP].filter(Boolean).join(" · ") || "-"}</span>
        </dd>
        <dt>Transcript</dt>
        <dd>{v.transcript ?? "-"}</dd>
        <Show when={v.uniprot}>
          {(uniprot) => (
            <>
              <dt>UniProt</dt>
              <dd>
                <a
                  onClick={() =>
                    mcp.openLink(`https://www.uniprot.org/uniprotkb/${encodeURIComponent(uniprot())}/entry`)
                  }
                >
                  {uniprot()}
                </a>
              </dd>
            </>
          )}
        </Show>
      </dl>
    </section>
  );
}

function ClinvarSection(props: {
  v: VariantCard;
  mcp: McpApp<VariantCardData>;
  all: Accessor<boolean>;
  toggle: () => void;
}) {
  const { mcp, all, toggle } = props;
  const cv = props.v.clinvar;
  if (!cv)
    return (
      <section>
        <h2>ClinVar</h2>
        <div class="empty">Not in ClinVar</div>
      </section>
    );
  return (
    <section>
      <h2>
        ClinVar{" "}
        <Show when={cv.url}>{(url) => <a onClick={() => mcp.openLink(url())}>Variation {cv.variantId}</a>}</Show>
      </h2>
      <div class="sig">
        <span class="badge" style={{ background: sigColor(cv.significance) }}>
          {cv.significance}
        </span>{" "}
        <Stars n={cv.stars} /> <span class="muted">best review status</span>
      </div>
      <div class="counts">
        {cv.records.length} records:{" "}
        <For each={Object.entries(cv.counts)}>
          {([s, n], i) => (
            <>
              {i() ? " · " : ""}
              <span>
                <i class="dot" style={{ background: sigColor(s) }} />
                {s} {n}
              </span>
            </>
          )}
        </For>
      </div>
      <table>
        <thead>
          <tr>
            <th>Significance</th>
            <th>Condition</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          <For each={all() ? cv.records : cv.records.slice(0, MAX_RECORDS)}>
            {(r) => (
              <tr
                title={`${r.accession} · ${r.reviewStatus} · last evaluated ${r.lastEvaluated ?? "-"} · ${r.submitters ?? "?"} submitters`}
              >
                <td>
                  <span class="dot" style={{ background: sigColor(r.significance) }} />
                  {r.significance}
                </td>
                <td>{r.condition}</td>
                <td class="stars">
                  <Stars n={r.stars} />
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={cv.records.length > MAX_RECORDS}>
        <div class="more">
          <a onClick={toggle}>{all() ? "Show fewer" : `Show all ${cv.records.length} records`}</a>
        </div>
      </Show>
    </section>
  );
}

/** Allele frequency bars, genomes and exomes per population, the most frequent first */
function Gnomad(props: { v: VariantCard; mcp: McpApp<VariantCardData> }) {
  const { v, mcp } = props;
  const sets = (["genome", "exome"] as const).filter((k) => v.gnomad[k]);
  if (!sets.length)
    return (
      <section>
        <h2>gnomAD</h2>
        <div class="empty">Not in gnomAD</div>
      </section>
    );
  const pops: Record<string, { name: string } & Partial<Record<GnomadSet, number>>> = {};
  for (const k of sets) for (const p of v.gnomad[k]!.populations) (pops[p.code] ??= { name: p.name })[k] = p.af;
  const rows = Object.values(pops).sort(
    (a, b) => Math.max(b.genome ?? 0, b.exome ?? 0) - Math.max(a.genome ?? 0, a.exome ?? 0),
  );
  const max = Math.max(...rows.flatMap((r) => [r.genome ?? 0, r.exome ?? 0]), 1e-9);
  return (
    <section>
      <h2>
        gnomAD allele frequencies{" "}
        <Show when={v.links.gnomAD}>{(url) => <a onClick={() => mcp.openLink(url())}>Browser</a>}</Show>
      </h2>
      <div class="freq-summary">
        <For each={sets}>
          {(k) => {
            const f = v.gnomad[k]!;
            return (
              <span>
                <i style={{ background: SET_COLORS[k] }} />
                <b>{k}s</b> AF {fmtAf(f.af)} · {fmtInt(f.ac)} / {fmtInt(f.an)} alleles · {fmtInt(f.hom)} homozygotes
              </span>
            );
          }}
        </For>
      </div>
      <div class="freqs">
        <For each={rows}>
          {(r) => (
            <>
              <span>{r.name}</span>
              <span class="bars">
                <For each={sets}>
                  {(k) => (
                    <span
                      style={{ width: `${((r[k] ?? 0) / max) * 100}%`, background: SET_COLORS[k] }}
                      title={`${k}s ${fmtAf(r[k])}`}
                    />
                  )}
                </For>
              </span>
              <span class="val">
                <For each={sets}>
                  {(k, i) => (
                    <>
                      {i() ? <br /> : ""}
                      {fmtAf(r[k])}
                    </>
                  )}
                </For>
              </span>
            </>
          )}
        </For>
      </div>
    </section>
  );
}

/** Gauge zones from the thresholds, colored by level in the direction of the score, marker at the score */
function Gauge(props: { p: Prediction }) {
  const { p } = props;
  const bounds = [p.min, ...p.thresholds, p.max];
  const zoneLevels: Level[] = !p.higherIsWorse
    ? ["damaging", "benign"]
    : p.thresholds.length === 1
      ? ["benign", "damaging"]
      : ["benign", "uncertain", "damaging"];
  const at = Math.min(100, Math.max(0, ((p.score - p.min) / (p.max - p.min)) * 100));
  return (
    <div class="pred">
      <div class="line">
        <span>
          <b>{p.name}</b> {p.score.toPrecision(3)}
        </span>
        <span style={{ color: LEVEL_COLORS[p.level] }}>{p.label}</span>
      </div>
      <div class="gauge" title={`Thresholds ${p.thresholds.join(", ")}`}>
        <For each={bounds.slice(0, -1)}>
          {(b, i) => (
            <span
              class="zone"
              style={{
                width: `${((bounds[i() + 1] - b) / (p.max - p.min)) * 100}%`,
                background: LEVEL_COLORS[zoneLevels[i()]],
              }}
            />
          )}
        </For>
        <span class="marker" style={{ left: `${at}%` }} />
      </div>
    </div>
  );
}

function Predictions(props: { v: VariantCard }) {
  return (
    <section>
      <h2>Predictions</h2>
      <Show
        when={props.v.predictions.length}
        fallback={
          <div class="empty">
            No missense prediction (CADD, SIFT, PolyPhen-2, REVEL, AlphaMissense) for this variant
          </div>
        }
      >
        <For each={props.v.predictions}>{(p) => <Gauge p={p} />}</For>
        <div class="legend">
          <span>
            <i style={{ background: "var(--benign)", opacity: 0.5 }} />
            benign
          </span>
          <span>
            <i style={{ background: "var(--uncertain)", opacity: 0.5 }} />
            uncertain
          </span>
          <span>
            <i style={{ background: "var(--pathogenic)", opacity: 0.5 }} />
            damaging
          </span>
          <span>most severe of the transcripts</span>
        </div>
      </Show>
    </section>
  );
}

// Styles of the widget, after the common ones of lib/common.css
export const styles = css`
  :root {
    --pathogenic: #cf222e;
    --likely: #e16f24;
    --uncertain: #bf8700;
    --benign: #1a7f37;
    --genome: #4c8bf5;
    --exome: #9c5fd6;
  }
  :root[data-theme="dark"] {
    --pathogenic: #f85149;
    --likely: #f0883e;
    --uncertain: #d29922;
    --benign: #3fb950;
  }
  header h1 .id {
    font-weight: 400;
    color: var(--muted);
    font-size: 13px;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    font-size: 12px;
  }
  .tabs button {
    font-size: 12px;
    padding: 2px 10px;
  }
  .tabs button.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--hover);
  }
  .note {
    padding: 6px 10px;
    margin-bottom: 10px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--uncertain) 14%, transparent);
    font-size: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 10px;
  }
  section {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--panel);
    min-width: 0;
  }
  section h2 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    display: flex;
    gap: 8px;
    align-items: baseline;
  }
  section h2 a {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 3px 12px;
    margin: 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 12px;
  }
  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    color: #fff;
    background: var(--muted);
  }
  .sig {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .sig .badge {
    font-size: 14px;
    padding: 3px 12px;
    border-radius: 14px;
  }
  .stars {
    color: #d4a72c;
    letter-spacing: 1px;
    font-size: 14px;
  }
  .counts {
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 6px;
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
    vertical-align: top;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    border-top: 0;
  }
  td .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 5px;
  }
  td.stars {
    font-size: 11px;
    white-space: nowrap;
  }
  .more {
    margin-top: 4px;
    font-size: 12px;
  }
  /* Allele frequency bars, genomes and exomes per population */
  .freq-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 12px;
    margin-bottom: 8px;
  }
  .freq-summary i,
  .legend i {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 2px;
    margin-right: 4px;
    vertical-align: -1px;
  }
  .freqs {
    display: grid;
    grid-template-columns: minmax(80px, max-content) minmax(60px, 1fr) 62px;
    gap: 1px 8px;
    align-items: center;
    font-size: 12px;
  }
  .freqs .bars {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 2px 0;
  }
  .freqs .bars span {
    height: 6px;
    border-radius: 0 3px 3px 0;
    min-width: 1px;
  }
  .freqs .val {
    text-align: right;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
    font-size: 11px;
  }
  .legend {
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    white-space: nowrap;
  }
  /* Prediction gauges: colored zones by threshold, marker at the score */
  .pred {
    margin-bottom: 8px;
  }
  .pred .line {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
  }
  .pred .line b {
    font-weight: 600;
  }
  .gauge {
    position: relative;
    height: 8px;
    border-radius: 4px;
    overflow: visible;
    display: flex;
    margin-top: 3px;
  }
  .gauge .zone {
    height: 100%;
    opacity: 0.35;
  }
  .gauge .zone:first-child {
    border-radius: 4px 0 0 4px;
  }
  .gauge .zone:last-child {
    border-radius: 0 4px 4px 0;
  }
  .gauge .marker {
    position: absolute;
    top: -3px;
    width: 4px;
    height: 14px;
    margin-left: -2px;
    border-radius: 2px;
    background: var(--fg);
    box-shadow: 0 0 0 2px var(--panel);
  }
  .actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .empty {
    color: var(--muted);
    font-size: 12px;
  }
`;
