import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import solid from "rolldown-plugin-solid";

// Shared lint, format and test config for the workspace, packages only define their `pack` build
export default defineConfig({
  plugins: [solid() as Plugin],
  // Relative asset URLs, so the demo works under any path, e.g. https://<user>.github.io/<repo>/
  base: "./",
  test: {
    projects: [
      // Connectors and parsing, in Node
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/tests/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/*.browser.test.ts"],
        },
      },
      // Components and the Chat class, in a real headless Chromium
      {
        extends: true,
        test: {
          name: "browser",
          include: ["packages/*/tests/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: playwright() as any,
            headless: true,
            instances: [{ browser: "chromium" }],
            // Desktop width, the sidebar is an overlay below 700px
            viewport: { width: 1280, height: 800 },
          },
        },
      },
      // End user tests: builds the demo, serves it like GitHub Pages and drives it with Playwright
      {
        extends: true,
        test: { name: "e2e", include: ["tests/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
      },
    ],
  },
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
    ignorePatterns: [".claude/**", "**/dist/**", "CHANGELOG.md"],
  },
  staged: {
    "*.{js,ts,tsx,vue,svelte}": "vp check --fix",
  },
  run: {
    // cache: true,
    tasks: {
      "build:py": {
        dependsOn: ["light-chat#build"],
        command: [
          "mkdir -p packages/python/src/light_chat/static",
          "cp packages/js/dist/index.js packages/python/src/light_chat/static/light-chat.js",
          "uv build --package light-chat --out-dir packages/python/dist",
        ],
        cache: false,
      },
      server: {
        dependsOn: ["build:py"],
        command: ["cd server && uv run --env-file .env uvicorn app:app --port 8083 --reload"],
      },
      // Widgets of the MCP servers bundled in `pdn-agent/mcp_servers/widgets/dist/`
      pdn: {
        dependsOn: ["build:py", "pdn-agent#build"],
        command: ["cd pdn-agent && uv run --env-file .env uvicorn app:app --port 8083 --reload"],
      },
    },
  },
});
