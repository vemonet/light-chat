// STRING protein network drawn with Cytoscape.js, proteins clustered with Louvain
import cytoscape from "cytoscape";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { css, cssRgb } from "./lib/styles.ts";
import { Logo } from "./lib/logos.tsx";
import { createMcpApp, FullscreenButton, type McpApp } from "./lib/mcp-app.tsx";

interface Node {
  /** STRING ID, e.g. 9606.ENSP00000269305 */
  id: string;
  name: string;
  annotation: string;
  /** Asked for, else added as a top partner */
  query: boolean;
}

interface Edge {
  source: string;
  target: string;
  score: number;
  /** Score of each evidence channel */
  scores: Record<string, number>;
  /** Channel with the highest score */
  channel: string;
}

/** `structuredContent` of the `show_string_network` tool */
interface NetworkData {
  species: number;
  organism: string | null;
  minScore: number;
  networkType: string;
  nodes: Node[];
  edges: Edge[];
  /** Queries STRING did not find */
  missing: string[];
  /** PPI enrichment p-value of the queried proteins */
  pValue: number | null;
  expectedEdges: number | null;
  url: string;
}

/** Data of the Cytoscape elements, the cluster is 0 for proteins alone */
interface NodeData extends Node {
  degree: number;
  cluster: number;
  size: number;
  color: string;
}
interface EdgeData extends Edge {
  id: string;
  color: string;
}

/** Protein or interaction shown in the details, its data copied when shown */
type Details = { node: NodeData; partners: string[] } | { edge: EdgeData };

// Evidence channel colors, close to the STRING ones
const CHANNELS: Record<string, [color: string, label: string]> = {
  experiments: ["#d6336c", "Experiments"],
  databases: ["#1aa2b8", "Databases"],
  textmining: ["#9bbb1e", "Text mining"],
  coexpression: ["#8c959f", "Coexpression"],
  neighborhood: ["#2f9e44", "Neighborhood"],
  fusion: ["#e8590c", "Gene fusion"],
  cooccurrence: ["#3b5bdb", "Co-occurrence"],
};
const CLUSTER_COLORS = [
  "#4c8bf5",
  "#f08c00",
  "#2b9e5a",
  "#e5484d",
  "#9c5fd6",
  "#12a4b5",
  "#d6409f",
  "#8d7a3a",
  "#6b8e23",
  "#7c6ff0",
];
const cssColor = (name: string) => `rgb(${cssRgb(name).join(",")})`;
/** `mapData()` mapper of a numeric style property, missing from the Cytoscape types */
const mapData = (args: string) => `mapData(${args})` as unknown as number;

/** Cytoscape style, from the theme colors */
function style(): cytoscape.StylesheetJson {
  const [fg, bg, accent] = ["--fg", "--bg", "--accent"].map(cssColor);
  return [
    {
      selector: "node",
      style: {
        "background-color": "data(color)",
        label: "data(name)",
        color: fg,
        "font-size": 12,
        "font-weight": 600,
        "text-valign": "bottom",
        "text-margin-y": 3,
        "text-outline-color": bg,
        "text-outline-width": 2,
        width: "data(size)",
        height: "data(size)",
        "border-width": 1,
        "border-color": bg,
      },
    },
    // Queried proteins outlined when partners were added
    { selector: "node[?query].outlined", style: { "border-width": 2.5, "border-color": fg } },
    {
      selector: "edge",
      style: {
        "line-color": "data(color)",
        width: mapData("score, 0.15, 1, 1, 4.5"),
        opacity: mapData("score, 0.15, 1, 0.25, 0.75"),
        "curve-style": "haystack",
      },
    },
    // Interactions between clusters, fainter so clusters stand out
    { selector: "edge.between", style: { opacity: mapData("score, 0.15, 1, 0.12, 0.4") } },
    { selector: ".faded", style: { opacity: 0.08 } },
    { selector: "edge.focus", style: { opacity: 0.9 } },
    { selector: "node.selected", style: { "border-color": accent, "border-width": 4 } },
    {
      selector: "edge.selected",
      style: { opacity: 1, "underlay-color": accent, "underlay-opacity": 0.35, "underlay-padding": 3 },
    },
  ];
}

/** Louvain communities maximizing modularity, weighted by `weight(edge)`: community index of each node.
 * Markov clustering puts everything in one cluster in hub dominated networks, like a protein and its partners */
function communities(ids: string[], edges: Edge[], weight: (e: Edge) => number) {
  const at = new Map(ids.map((id, i) => [id, i]));
  let adj = ids.map(() => new Map<number, number>());
  for (const e of edges) {
    const [a, b, w] = [at.get(e.source)!, at.get(e.target)!, weight(e)];
    adj[a].set(b, (adj[a].get(b) ?? 0) + w);
    adj[b].set(a, (adj[b].get(a) ?? 0) + w);
  }
  let membership = ids.map((_, i) => i);
  for (;;) {
    // Move each node to the neighbor community with the best modularity gain, until stable
    const k = adj.map((row) => [...row.values()].reduce((s, w) => s + w, 0));
    const m2 = k.reduce((s, x) => s + x, 0) || 1;
    const comm = adj.map((_, i) => i);
    const tot = [...k];
    let improved = false;
    for (let moved = true; moved;) {
      moved = false;
      for (let i = 0; i < adj.length; i++) {
        const links = new Map<number, number>();
        for (const [j, w] of adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + w);
        tot[comm[i]] -= k[i];
        let best = comm[i];
        let bestGain = (links.get(best) ?? 0) - (tot[best] * k[i]) / m2;
        for (const [c, w] of links) {
          const gain = w - (tot[c] * k[i]) / m2;
          if (gain > bestGain + 1e-9) [best, bestGain] = [c, gain];
        }
        tot[best] += k[i];
        if (best !== comm[i]) [comm[i], moved, improved] = [best, true, true];
      }
    }
    if (!improved) return membership;
    // Communities become the nodes of the next level
    const index = new Map<number, number>();
    for (const c of comm) if (!index.has(c)) index.set(c, index.size);
    membership = membership.map((c) => index.get(comm[c])!);
    const next = [...index.keys()].map(() => new Map<number, number>());
    adj.forEach((row, i) => {
      for (const [j, w] of row) {
        const [a, b] = [index.get(comm[i])!, index.get(comm[j])!];
        next[a].set(b, (next[a].get(b) ?? 0) + w);
      }
    });
    adj = next;
  }
}

export default function Widget() {
  const mcp = createMcpApp<NetworkData>("STRING network", "show_string_network");
  // A new tool result recreates the graph, which resets the filters and selection
  return (
    <Show
      when={mcp.data()?.nodes?.length ? mcp.data() : undefined}
      keyed
      fallback={
        <header>
          <h1>{mcp.data() === undefined ? "Loading the STRING network" : "No STRING network"}</h1>
        </header>
      }
    >
      {(data) => <Network data={data} mcp={mcp} />}
    </Show>
  );
}

function Network(props: { data: NetworkData; mcp: McpApp<NetworkData> }) {
  // Fixed for a tool result
  const { data, mcp } = props;
  const names = Object.fromEntries(data.nodes.map((n) => [n.id, n.name]));
  const queried = data.nodes.filter((n) => n.query).map((n) => n.name);
  const p =
    data.pValue == null ? "" : ` · PPI enrichment p-value ${data.pValue ? data.pValue.toExponential(1) : "< 1e-16"}`;
  const missing = data.missing.length ? ` · not found: ${data.missing.join(", ")}` : "";

  // Options of the toolbar: score shown while dragging, min score applied on release, channels hidden from the legend
  const [score, setScore] = createSignal(data.minScore);
  const [min, setMin] = createSignal(data.minScore);
  const [colorBy, setColorBy] = createSignal("cluster");
  const [hidden, setHidden] = createSignal(new Set<string>());
  // Element clicked, and details of the element clicked or hovered
  const [selected, setSelected] = createSignal<string>();
  const [details, setDetails] = createSignal<Details>();

  // Interactions above the score, of the channels shown, proteins clustered
  const graph = createMemo(() => {
    const edges = data.edges.filter((e) => e.score >= min() && !hidden().has(e.channel));
    const degree: Record<string, number> = {};
    for (const e of edges) for (const id of [e.source, e.target]) degree[id] = (degree[id] ?? 0) + 1;
    const maxDegree = Math.max(1, ...Object.values(degree));
    // Clusters numbered by size, proteins alone left grey. Scores to the 4th power, to favor strong links
    const ids = data.nodes.map((n) => n.id);
    const membership = communities(ids, edges, (e) => e.score ** 4);
    const sizes: Record<string, number> = {};
    for (const c of membership) sizes[c] = (sizes[c] ?? 0) + 1;
    const ranks = Object.keys(sizes)
      .filter((c) => sizes[c] > 1)
      .sort((a, b) => sizes[b] - sizes[a]);
    const cluster = Object.fromEntries(ids.map((id, i) => [id, ranks.indexOf(String(membership[i])) + 1]));
    const elements: cytoscape.ElementDefinition[] = [
      ...data.nodes.map((n) => ({
        data: {
          ...n,
          degree: degree[n.id] ?? 0,
          cluster: cluster[n.id],
          size: 18 + 18 * Math.sqrt((degree[n.id] ?? 0) / maxDegree),
        },
      })),
      ...edges.map((e, i) => ({ data: { ...e, id: `e${i}`, color: CHANNELS[e.channel][0] } })),
    ];
    return { edges, clusters: ranks.length, elements };
  });

  // Channel legend, with the interactions above the score, hidden channels included
  const legend = createMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of data.edges) if (e.score >= min()) counts[e.channel] = (counts[e.channel] ?? 0) + 1;
    return Object.entries(CHANNELS)
      .filter(([c]) => counts[c])
      .map(([channel, [color, label]]) => ({ channel, color, label, count: counts[channel] }));
  });

  function toggleChannel(c: string) {
    const next = new Set(hidden());
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setHidden(next);
  }

  // Cytoscape owns its canvas in this container
  let container!: HTMLDivElement;
  let cy!: cytoscape.Core;

  function colorNodes() {
    const byQuery = colorBy() === "query";
    const grey = cssColor("--muted");
    cy.nodes().forEach((n) => {
      const { cluster: c, query } = n.data() as NodeData;
      n.data(
        "color",
        byQuery ? (query ? cssColor("--accent") : grey) : c ? CLUSTER_COLORS[(c - 1) % CLUSTER_COLORS.length] : grey,
      );
    });
  }

  /** Each cluster laid out on its own, clusters side by side in rows, then proteins alone in a grid */
  function layout() {
    const groups: Record<number, cytoscape.CollectionReturnValue> = {};
    cy.nodes().forEach((n) => {
      const c = (n.data() as NodeData).cluster;
      groups[c] = (groups[c] ?? cy.collection()).union(n);
    });
    const keys = Object.keys(groups)
      .map(Number)
      .sort((a, b) => (a || Infinity) - (b || Infinity));
    const side = (k: number) =>
      k ? 62 * Math.sqrt(groups[k].length) + 30 : 60 * Math.ceil(Math.sqrt(groups[k].length));
    // Row width giving about the aspect ratio of the container
    const area = keys.reduce((s, k) => s + (side(k) + 40) ** 2, 0);
    const rowWidth = Math.max(
      ...keys.map(side),
      1.3 * Math.sqrt((area * container.clientWidth) / container.clientHeight),
    );
    let [x, y, rowHeight] = [0, 0, 0];
    for (const k of keys) {
      const w = side(k);
      if (x > 0 && x + w > rowWidth) [x, y, rowHeight] = [0, y + rowHeight + 40, 0];
      const nodes = groups[k];
      const common = { animate: false, boundingBox: { x1: x, y1: y, w, h: w }, padding: 0 };
      const options: cytoscape.LayoutOptions = k
        ? {
            name: "cose",
            randomize: true,
            nodeRepulsion: () => 6000,
            idealEdgeLength: () => 50,
            gravity: 0.8,
            ...common,
          }
        : { name: "grid", avoidOverlap: true, ...common };
      nodes.union(nodes.edgesWith(nodes)).layout(options).run();
      [x, rowHeight] = [x + w + 40, Math.max(rowHeight, w)];
    }
    fit();
  }

  /** Fit the graph, without zooming small networks too much */
  function fit() {
    cy.fit(undefined, 24);
    if (cy.zoom() > 1.4) {
      cy.zoom(1.4);
      cy.center();
    }
  }

  /** Details of a protein or an interaction, `quiet` for hover (no model context) */
  function select(id: string, quiet = false) {
    const el = cy.getElementById(id);
    if (!el.length) return;
    cy.elements().removeClass("selected faded focus");
    el.addClass("selected");
    if (el.group() === "nodes") {
      const d = { ...(el.data() as NodeData) };
      const partners = el
        .connectedEdges()
        .map((e) => e.data() as EdgeData)
        .sort((a, b) => b.score - a.score)
        .map((e) => `${names[e.source === id ? e.target : e.source]} (${e.score.toFixed(3)})`);
      cy.elements().not(el.closedNeighborhood()).addClass("faded");
      el.connectedEdges().addClass("focus");
      setDetails({ node: d, partners });
      if (!quiet) {
        const members = cy
          .nodes()
          .filter((x) => (x.data() as NodeData).cluster === d.cluster)
          .map((x) => (x.data() as NodeData).name);
        void mcp.updateContext(
          `The user selected ${d.name} (${d.id}) in the STRING network: ${d.degree} interactions${
            d.cluster ? `, cluster ${d.cluster} with ${members.join(", ")}` : ""
          }`,
        );
      }
    } else {
      const d = { ...(el.data() as EdgeData) };
      cy.elements().not(el.union(el.connectedNodes())).addClass("faded");
      setDetails({ edge: d });
      if (!quiet)
        void mcp.updateContext(
          `The user selected the STRING interaction ${names[d.source]} - ${names[d.target]}: combined score ${d.score}, ` +
            Object.entries(d.scores)
              .filter(([, s]) => s > 0)
              .map(([c, s]) => `${c} ${s}`)
              .join(", "),
        );
    }
  }

  function clearSelection() {
    setSelected();
    cy.elements().removeClass("selected faded focus");
    setDetails();
  }

  // Graph created once, hover shows details while nothing is clicked
  onMount(() => {
    cy = cytoscape({ container, style: style(), wheelSensitivity: 0.3, minZoom: 0.2, maxZoom: 4 });
    const target = (e: cytoscape.EventObject) => e.target as cytoscape.SingularElementArgument;
    cy.on("mouseover", "node, edge", (e) => !selected() && select(target(e).id(), true));
    cy.on("mouseout", "node, edge", () => !selected() && clearSelection());
    cy.on("tap", "node, edge", (e) => {
      setSelected(target(e).id());
      select(target(e).id());
    });
    cy.on("tap", (e) => e.target === cy && clearSelection());
    onCleanup(() => cy.destroy());
  });

  // Elements replaced when the score or channels change, laid out again, the clicked element selected again
  createEffect(
    on(graph, ({ elements }) => {
      cy.elements().remove();
      cy.add(elements);
      if (data.nodes.some((n) => !n.query)) cy.nodes().addClass("outlined");
      cy.edges()
        .filter((e) => e.source().data("cluster") !== e.target().data("cluster") || !e.source().data("cluster"))
        .addClass("between");
      colorNodes();
      layout();
      const id = selected();
      if (id) select(id, true);
    }),
  );
  createEffect(on(colorBy, colorNodes, { defer: true }));
  // Theme or size changed: restyle and fit the graph
  createEffect(
    on(
      mcp.host,
      () =>
        requestAnimationFrame(() => {
          cy.style(style());
          colorNodes();
          cy.resize();
          fit();
        }),
      { defer: true },
    ),
  );

  return (
    <>
      <header>
        <h1>
          {queried.length === 1
            ? `${queried[0]} and its STRING partners`
            : `STRING network of ${queried.length} proteins`}
        </h1>
        <span class="muted">
          {data.organism ?? data.species} · {data.networkType}
          {p}
          {missing}
        </span>
        <span class="spacer" />
        <a class="logo-link" title="Open in STRING" onClick={() => mcp.openLink(data.url)}>
          <Logo name="STRING" />
        </a>
        <FullscreenButton mcp={mcp} />
      </header>

      <div class="toolbar">
        <label>
          Min. score{" "}
          <input
            type="range"
            min={data.minScore}
            max="1"
            step="0.01"
            value={score()}
            onInput={(e) => setScore(Number(e.currentTarget.value))}
            onChange={() => setMin(score())}
          />{" "}
          <b>{score().toFixed(2)}</b>
        </label>
        <label>
          Color by
          <select onChange={(e) => setColorBy(e.currentTarget.value)}>
            <option value="cluster">Cluster</option>
            <option value="query">Queried or added</option>
          </select>
        </label>
        <button type="button" onClick={layout}>
          Re-layout
        </button>
        <span class="spacer" />
        <span>
          {data.nodes.length} proteins · {graph().edges.length} interactions · {graph().clusters} cluster
          {graph().clusters === 1 ? "" : "s"}
        </span>
      </div>

      <div id="graph" ref={container} />

      <div class="legend">
        <span class="muted" style={{ "align-self": "center" }}>
          Main evidence:
        </span>
        <For each={legend()}>
          {(c) => (
            <button
              type="button"
              classList={{ off: hidden().has(c.channel) }}
              title="Show or hide these interactions"
              onClick={() => toggleChannel(c.channel)}
            >
              <i style={{ background: c.color }} />
              {c.label} <span class="count">{c.count}</span>
            </button>
          )}
        </For>
      </div>

      <div class="details" classList={{ muted: !details() }}>
        <Show when={details()} keyed fallback="Hover or click a protein or an interaction for details">
          {(d) =>
            "node" in d ? (
              <>
                <div>
                  <span class="dot" style={{ background: d.node.color }} />
                  <b>{d.node.name}</b>{" "}
                  <span class="muted">
                    {d.node.id} · {d.node.query ? "queried" : "added partner"} · {d.node.degree} interactions
                    {d.node.cluster ? ` · cluster ${d.node.cluster}` : ""}
                  </span>
                </div>
                <div class="annotation">{d.node.annotation}</div>
                <Show when={d.partners.length}>
                  <div class="muted">
                    Partners: {d.partners.slice(0, 20).join(", ")}
                    {d.partners.length > 20 ? ", ..." : ""}
                  </div>
                </Show>
                <div class="actions">
                  <button
                    type="button"
                    class="primary"
                    onClick={() =>
                      void mcp.sendMessage(
                        `What is known about ${d.node.name} (${data.organism}) and its interactions with ${
                          d.partners
                            .slice(0, 8)
                            .map((p) => p.split(" ")[0])
                            .join(", ") || "other proteins"
                        }?`,
                      )
                    }
                  >
                    Ask about {d.node.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => mcp.openLink(`https://string-db.org/network/${encodeURIComponent(d.node.id)}`)}
                  >
                    STRING page
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      mcp.openLink(
                        `https://www.uniprot.org/uniprotkb?query=${encodeURIComponent(`gene_exact:${d.node.name} AND organism_id:${data.species}`)}`,
                      )
                    }
                  >
                    UniProt
                  </button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <b>
                    {names[d.edge.source]} - {names[d.edge.target]}
                  </b>{" "}
                  <span class="muted">
                    combined score {d.edge.score.toFixed(3)} · main evidence {CHANNELS[d.edge.channel][1].toLowerCase()}
                  </span>
                </div>
                {/* Score of each channel with evidence */}
                <div class="channels">
                  <For each={Object.entries(CHANNELS).filter(([c]) => d.edge.scores[c] > 0)}>
                    {([c, [color, label]]) => (
                      <>
                        <span>{label}</span>
                        <span class="bar">
                          <span style={{ width: `${(d.edge.scores[c] ?? 0) * 100}%`, background: color }} />
                        </span>
                        <span class="muted">{(d.edge.scores[c] ?? 0).toFixed(3)}</span>
                      </>
                    )}
                  </For>
                </div>
                <div class="actions">
                  <button
                    type="button"
                    class="primary"
                    onClick={() =>
                      void mcp.sendMessage(
                        `What is the evidence for the interaction between ${names[d.edge.source]} and ${names[d.edge.target]} (${data.organism}), and its biological role?`,
                      )
                    }
                  >
                    Ask about this interaction
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      mcp.openLink(
                        `https://string-db.org/interaction/${encodeURIComponent(d.edge.source)}/${encodeURIComponent(d.edge.target)}`,
                      )
                    }
                  >
                    STRING evidence
                  </button>
                </div>
              </>
            )
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
    gap: 6px 12px;
    align-items: center;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .toolbar label {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .toolbar input[type="range"] {
    width: 120px;
    padding: 0;
    accent-color: var(--accent);
  }
  .toolbar b {
    color: var(--fg);
    font-weight: 600;
    min-width: 30px;
  }
  #graph {
    height: 460px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
  }
  :root[data-mode="fullscreen"] #graph {
    height: calc(100vh - 250px);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    margin-top: 8px;
    font-size: 12px;
  }
  .legend button {
    display: flex;
    gap: 5px;
    align-items: center;
    padding: 1px 8px;
    border-radius: 12px;
    font-size: 12px;
  }
  .legend button.off {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .legend i {
    width: 14px;
    height: 3px;
    border-radius: 2px;
  }
  .legend .count {
    color: var(--muted);
  }
  .details {
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    /* Room for the details of a protein, so the frame does not resize on hover */
    min-height: 150px;
  }
  .details .annotation {
    margin: 4px 0;
    max-height: 62px;
    overflow-y: auto;
  }
  .details .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .details .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: -1px;
  }
  /* Score of each evidence channel of an interaction */
  .channels {
    display: grid;
    grid-template-columns: repeat(2, 90px minmax(60px, 180px) 40px);
    gap: 2px 8px;
    align-items: center;
    margin-top: 4px;
    font-size: 12px;
  }
  @media (max-width: 560px) {
    .channels {
      grid-template-columns: 90px minmax(60px, 1fr) 40px;
    }
  }
  .channels .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--border);
    overflow: hidden;
  }
  .channels .bar span {
    display: block;
    height: 100%;
  }
`;
