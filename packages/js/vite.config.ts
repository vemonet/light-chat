import { defineConfig } from "vite-plus";
import solid from "rolldown-plugin-solid";

// Framework agnostic build: the Solid component, solid-js, marked, dompurify and hljs are all bundled
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "browser",
    format: ["esm", "iife"],
    globalName: "LightChat",
    minify: true,
    dts: { tsgo: true },
    deps: {
      onlyBundle: ["light-chat-solid", "solid-js", "marked", "dompurify", "highlight.js"],
      // Inline the light-chat-solid types, it is not a dependency of the published package
      dts: { alwaysBundle: ["light-chat-solid"] },
    },
    plugins: [solid()],
  },
});
