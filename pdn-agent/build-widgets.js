// Bundles each MCP Apps widget of `mcp_servers/widgets/<name>.tsx` with its styles and npm dependencies in one HTML
// file `mcp_servers/widgets/dist/<name>.html`, served by the MCP servers. One build per widget: a single file can
// not share chunks with the others
import { readdirSync, rmSync } from "node:fs";
import solid from "rolldown-plugin-solid";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = new URL("mcp_servers/widgets/", import.meta.url).pathname;

/** Page and entry of a widget, generated: the entry adds the widget styles and renders its default export */
function widgetPage(name) {
  const page = `${root}${name}.html`;
  const entry = `${root}${name}.entry.tsx`;
  return {
    name: "widget-page",
    resolveId: (id) => ([page, entry].includes(id) || id === `./${name}.entry.tsx` ? id.replace("./", root) : null),
    load(id) {
      if (id === page)
        return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./${name}.entry.tsx"></script>
  </body>
</html>
`;
      if (id === entry)
        return `import "./lib/common.css";
import { render } from "solid-js/web";
import Widget, { styles } from "./${name}.tsx";

document.head.append(Object.assign(document.createElement("style"), { textContent: styles }));
render(() => <Widget />, document.getElementById("root"));
`;
    },
  };
}

// Widgets given by name, e.g. `node build-widgets.js pdn-lollipop`, else all of them in a clean folder
const args = process.argv.slice(2);
if (!args.length) rmSync(`${root}dist`, { recursive: true, force: true });
const names = args.length ? args : readdirSync(root).flatMap((f) => (f.endsWith(".tsx") ? [f.slice(0, -4)] : []));
for (const name of names) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    // Solid compiles the JSX of the widgets
    plugins: [widgetPage(name), solid(), viteSingleFile()],
    build: { outDir: "dist", emptyOutDir: false, rollupOptions: { input: `${root}${name}.html` } },
  });
  console.log(`Built ${name}.html`);
}
