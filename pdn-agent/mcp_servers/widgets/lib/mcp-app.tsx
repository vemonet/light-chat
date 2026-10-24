// Connection of the SolidJS widgets to the host with the MCP Apps SDK: tool result and host context as signals
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

export type McpApp<T> = ReturnType<typeof createMcpApp<T>>;

/** Connects to the host, `tool` is called again when the result has no `structuredContent` */
export function createMcpApp<T>(name: string, tool?: string) {
  const app = new App({ name, version: "0.0.1" }, { availableDisplayModes: ["inline", "fullscreen"] });
  // Undefined until the tool result, null when it has no data
  const [data, setData] = createSignal<T | null>();
  const [host, setHost] = createSignal<McpUiHostContext>({});

  // Theme, fonts and colors of the host, display mode as an attribute on <html> for the CSS
  const onContext = (ctx: McpUiHostContext) => {
    if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
    if (ctx.theme) applyDocumentTheme(ctx.theme);
    if (ctx.displayMode) document.documentElement.dataset.mode = ctx.displayMode;
    setHost((prev) => ({ ...prev, ...ctx }));
  };
  app.onhostcontextchanged = onContext;

  // Tool arguments, to call the tool again when the result has no `structuredContent`, as Claude Desktop gives to
  // widgets restored after a reload of the chat
  let toolArgs: Record<string, unknown> | undefined;
  app.ontoolinput = (params) => (toolArgs = params.arguments);
  app.ontoolresult = async (result) => {
    if (tool && !result.structuredContent && !result.isError && toolArgs) {
      result = await app.callServerTool({ name: tool, arguments: toolArgs }).catch(() => result);
    }
    setData(() => (result.structuredContent as T | undefined) ?? null);
  };
  void app.connect().then(() => onContext(app.getHostContext() ?? {}));

  const fullscreen = () => host().displayMode === "fullscreen";
  return {
    app,
    data,
    host,
    fullscreen,
    /** Full screen button only when the host offers it */
    canFullscreen: () => host().availableDisplayModes?.includes("fullscreen") ?? true,
    // The host answers with the mode set, it may not send a context change
    toggleFullscreen: async () => {
      const { mode } = await app.requestDisplayMode({ mode: fullscreen() ? "inline" : "fullscreen" });
      onContext({ displayMode: mode });
    },
    openLink: (url: string) => void app.openLink({ url }),
    sendMessage: (text: string) => app.sendMessage({ role: "user", content: [{ type: "text", text }] }),
    updateContext: (text: string) => app.updateModelContext({ content: [{ type: "text", text }] }),
  };
}

/** Button switching between inline and full screen, when the host offers it */
export function FullscreenButton(props: { mcp: McpApp<unknown> }) {
  return (
    <Show when={props.mcp.canFullscreen()}>
      <button type="button" onClick={() => void props.mcp.toggleFullscreen()}>
        {props.mcp.fullscreen() ? "Exit full screen" : "Full screen"}
      </button>
    </Show>
  );
}

/** Width of an element and height of the window as signals, for the charts drawn to fit them */
export function createSize(element: () => HTMLElement) {
  const [width, setWidth] = createSignal(0);
  const [windowHeight, setWindowHeight] = createSignal(innerHeight);
  onMount(() => {
    setWidth(element().clientWidth);
    const observer = new ResizeObserver(() => setWidth(element().clientWidth));
    observer.observe(element());
    const onResize = () => setWindowHeight(innerHeight);
    addEventListener("resize", onResize);
    onCleanup(() => {
      observer.disconnect();
      removeEventListener("resize", onResize);
    });
  });
  return { width, windowHeight };
}
