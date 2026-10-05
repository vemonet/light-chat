import { defineConfig, type Plugin } from "vite-plus";
import solid from "rolldown-plugin-solid";
import { mockBackend } from "./demo/mock.ts";

// Shared lint, format and test config for the workspace, packages only define their `pack` build
export default defineConfig({
  // Dev playground (`vp dev`): serves index.html with mock streaming endpoints
  // rolldown-plugin-solid is typed against its own rolldown version, it works as a Vite plugin
  plugins: [solid() as Plugin, mockBackend()],
  lint: {
    // Solid refs (`let el!: T` + `ref={el}`) are assigned by the JSX compiler
    rules: { "no-unassigned-vars": "off" },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    printWidth: 120,
    ignorePatterns: [".claude/**", "**/dist/**"],
  },
});
