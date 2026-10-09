import { defineConfig } from "vite-plus";
import type { PackUserConfig, TsdownPluginOption } from "vite-plus/pack";
import solid from "rolldown-plugin-solid";

// Framework agnostic build: the Solid component, solid-js, marked, dompurify and hljs are all bundled
const shared: PackUserConfig = {
  platform: "browser",
  minify: true,
  deps: {
    onlyBundle: ["light-chat-solid", "solid-js", "marked", "dompurify", "highlight.js"],
    // Inline the light-chat-solid types, it is not a dependency of the published package
    dts: { alwaysBundle: ["light-chat-solid"] },
  },
  // Typed with an older Rolldown than the one of vite-plus
  plugins: [solid() as TsdownPluginOption],
};

export default defineConfig({
  pack: [
    // ESM module with types, the default
    { ...shared, entry: ["src/index.ts"], format: ["esm"], dts: true },
    // Classic script exposing a `LightChat` global
    { ...shared, entry: ["src/index.ts"], format: ["iife"], globalName: "LightChat", dts: false },
  ],
});
