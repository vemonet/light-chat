// Bundles each MCP Apps widget of `mcp_servers/widgets/` with its scripts, styles and npm dependencies in one HTML
// file in `mcp_servers/widgets/dist/`, served by the MCP servers. One build per widget: a single file can not
// share chunks with the others
import { readdirSync, rmSync } from "node:fs";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = new URL("mcp_servers/widgets/", import.meta.url).pathname;
rmSync(`${root}dist`, { recursive: true, force: true });
for (const page of readdirSync(root).filter((f) => f.endsWith(".html"))) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [viteSingleFile()],
    build: { outDir: "dist", emptyOutDir: false, rollupOptions: { input: `${root}${page}` } },
  });
  console.log(`Built ${page}`);
}
