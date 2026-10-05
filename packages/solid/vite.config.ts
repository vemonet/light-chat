import { defineConfig } from "vite-plus";
import solid from "rolldown-plugin-solid";

// Solid component library: solid-js (peer) and dependencies stay external
export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "browser",
    format: ["esm"],
    dts: { tsgo: true },
    plugins: [solid()],
  },
});
