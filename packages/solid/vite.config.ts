import { defineConfig } from "vite-plus";
import solid from "rolldown-plugin-solid";
import type { TsdownPluginOption } from "vite-plus/pack";

// Solid component library: solid-js (peer) and dependencies stay external
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "browser",
    format: ["esm"],
    dts: true,
    // Typed with an older Rolldown than the one of vite-plus
    plugins: [solid() as TsdownPluginOption],
  },
});
