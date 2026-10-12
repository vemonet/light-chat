import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import sparql from "./sparql.ts";

// Common languages only, to keep the bundle small (aliases like sh, js, ts, html, yml come with them)
const languages = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sparql,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Copy and check icons, CSS swaps them while the button has `data-copied`
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const copyIcons =
  svg(
    '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  ) + svg('<path d="M20 6 9 17l-5-5"/>');

/** Highlight code to HTML, falls back to escaped text for unknown languages */
export function highlight(code: string, lang?: string): string {
  return lang && hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : escape(code);
}

const marked = new Marked({
  gfm: true,
  renderer: {
    // Code blocks get a header with the language and a copy button (handled by event delegation)
    code({ text, lang }) {
      const language = (lang ?? "").split(/\s/)[0];
      return (
        `<div class="lc-code"><div class="lc-code-head"><span>${escape(language || "text")}</span>` +
        `<button type="button" class="lc-code-copy" aria-label="Copy code">${copyIcons}</button></div>` +
        `<pre><code class="hljs">${highlight(text, language)}</code></pre></div>`
      );
    },
  },
});

// Open links in a new tab
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export const renderMarkdown = (md: string): string => DOMPurify.sanitize(marked.parse(md, { async: false }));
