import { expect, test } from "vite-plus/test";
import hljs from "highlight.js/lib/core";
import sparql from "../src/sparql.ts";

// markdown.ts needs a DOM for DOMPurify, so the language is registered on its own here
hljs.registerLanguage("sparql", sparql);
const highlight = (code: string, language: string) => hljs.highlight(code, { language }).value;

test("SPARQL code blocks are highlighted", () => {
  const html = highlight(
    `PREFIX up: <http://purl.uniprot.org/core/>
# Reviewed human proteins
SELECT ?protein (COUNT(?s) AS ?n) WHERE {
  ?protein a up:Protein ; rdfs:label "kinase"@en .
  FILTER(?n < 5 && ?n > 1)
} LIMIT 10`,
    "sparql",
  );
  expect(html).toContain('<span class="hljs-keyword">PREFIX</span> <span class="hljs-attr">up:</span>');
  expect(html).toContain('<span class="hljs-title">&lt;http://purl.uniprot.org/core/&gt;</span>');
  expect(html).toContain('<span class="hljs-comment"># Reviewed human proteins</span>');
  expect(html).toContain('<span class="hljs-built_in">COUNT</span>');
  expect(html).toContain('<span class="hljs-variable">?protein</span> <span class="hljs-keyword">a</span>');
  expect(html).toContain('<span class="hljs-attr">up:Protein</span>');
  expect(html).toContain('<span class="hljs-string">&quot;kinase&quot;</span><span class="hljs-meta">@en</span>');
  // Comparisons are not taken for an IRI
  expect(html).not.toContain('<span class="hljs-title">&lt; 5');
  expect(html).toContain('<span class="hljs-number">10</span>');
  // Alias
  expect(highlight("ASK { ?s ?p ?o }", "rq")).toContain('<span class="hljs-keyword">ASK</span>');
});
