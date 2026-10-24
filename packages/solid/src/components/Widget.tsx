import { createEffect, createResource, createSignal, on, Match, onCleanup, Show, Switch, useContext } from "solid-js";
import { unwrap } from "solid-js/store";
import { ChatContext, type ChatController } from "../store.ts";
import type { ActivityPart, McpRequest } from "../types.ts";
import { humanize } from "../utils.ts";
import { AppIcon, CloseIcon } from "./icons.tsx";
import { version } from "../../package.json";

/** Activity type of tool results with a UI, from the AG-UI MCP Apps middleware */
export const WIDGET_ACTIVITY = "mcp-apps";

const PROTOCOL_VERSION = "2026-01-26";

interface Csp {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

/** `_meta.ui` of an MCP App resource */
interface UiMeta {
  csp?: Csp;
  permissions?: Record<string, object>;
  prefersBorder?: boolean;
}

interface EmbeddedResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** MCP tool, `_meta.ui` links it to an MCP App and sets who can call it */
interface Tool {
  name: string;
  _meta?: { ui?: { resourceUri?: string; visibility?: string[] }; "ui/resourceUri"?: string };
}

/** Content of an `mcp-apps` activity: a tool result, shown when it has a UI */
export interface WidgetContent {
  /** MCP `CallToolResult` of the tool */
  result?: { content?: { type: string; resource?: EmbeddedResource }[] };
  /** Tool called, with its `_meta` */
  tool?: Tool;
  /** UI resource of an MCP App (AG-UI MCP Apps middleware), else from the tool `_meta` */
  resourceUri?: string;
  serverHash?: string;
  serverId?: string;
  toolInput?: Record<string, unknown>;
}

/** MCP App resource of the tool */
const resourceUriOf = (c: WidgetContent) =>
  c.resourceUri ?? c.tool?._meta?.ui?.resourceUri ?? c.tool?._meta?.["ui/resourceUri"];

/** MCP-UI: first `ui://` resource embedded in the result */
const embeddedUiOf = (c: WidgetContent) =>
  c.result?.content?.find((b) => b.resource?.uri.startsWith("ui://"))?.resource;

/** Whether a tool result has a UI to show */
export const hasUi = (content: unknown) =>
  !!(resourceUriOf(content as WidgetContent) || embeddedUiOf(content as WidgetContent));

/** What the iframe shows: an MCP App, MCP-UI HTML or URL, or an unsupported resource */
type Ui =
  | { kind: "app"; html: string; meta: UiMeta }
  | { kind: "html"; html: string }
  | { kind: "url"; url: string }
  | { kind: "unsupported"; mimeType: string };

/** Resource text, `blob` is base64 */
const textOf = (r: EmbeddedResource) =>
  r.text ?? new TextDecoder().decode(Uint8Array.from(atob(r.blob ?? ""), (c) => c.charCodeAt(0)));

async function loadUi(content: WidgetContent, request: (r: McpRequest) => Promise<unknown>): Promise<Ui> {
  const uri = resourceUriOf(content);
  if (uri) {
    const { serverHash, serverId } = content;
    const res = (await request({ serverHash, serverId, method: "resources/read", params: { uri } })) as {
      contents: (EmbeddedResource & { _meta?: { ui?: UiMeta } })[];
    };
    const resource = res.contents[0];
    return { kind: "app", html: textOf(resource), meta: resource._meta?.ui ?? {} };
  }
  const resource = embeddedUiOf(content);
  const mimeType = resource?.mimeType ?? "";
  if (resource && mimeType.startsWith("text/html")) return { kind: "html", html: textOf(resource) };
  if (resource && mimeType.startsWith("text/uri-list")) {
    const url = textOf(resource)
      .split(/\r?\n/)
      .find((l) => l.trim() && !l.startsWith("#"));
    if (url) return { kind: "url", url: url.trim() };
  }
  return { kind: "unsupported", mimeType: mimeType || "unknown" };
}

/** Content Security Policy of an MCP App, allowing only the domains it declares */
function cspOf(csp: Csp = {}) {
  const list = (domains?: string[]) => (domains?.length ? ` ${domains.join(" ")}` : "");
  const res = list(csp.resourceDomains);
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' blob:${res}`,
    `style-src 'self' 'unsafe-inline'${res}`,
    `img-src 'self' data: blob:${res}`,
    `media-src 'self' data: blob:${res}`,
    `font-src 'self' data:${res}`,
    `worker-src 'self' blob:${res}`,
    "object-src 'none'",
    `connect-src ${csp.connectDomains?.length ? `'self'${list(csp.connectDomains)}` : "'none'"}`,
    `frame-src ${csp.frameDomains?.length ? csp.frameDomains.join(" ") : "'none'"}`,
    `base-uri ${csp.baseUriDomains?.length ? csp.baseUriDomains.join(" ") : "'self'"}`,
  ].join("; ");
}

/** HTML with the CSP as a meta tag at the start of <head> */
function withCsp(html: string, csp?: Csp) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspOf(csp)}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => head + meta) : meta + html;
}

/** Permissions requested by the app, as an iframe `allow` attribute */
const allowOf = (permissions: Record<string, object> = {}) =>
  Object.keys(permissions)
    .map((p) => (p === "clipboardWrite" ? "clipboard-write" : p))
    .join("; ");

const theme = (chat: ChatController) =>
  chat.state.theme !== "auto"
    ? chat.state.theme
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";

/**
 * Interactive UI of a tool result, in a sandboxed iframe: an MCP App (JSON-RPC bridge, `ui/*` methods)
 * or an MCP-UI resource (HTML or external URL, `postMessage` actions). Its MCP requests go through the connector.
 */
export function Widget(props: { part: ActivityPart }) {
  const chat = useContext(ChatContext)!;
  // Plain object: store proxies can not be sent with postMessage
  const content = unwrap(props.part.content) as WidgetContent;
  const server = { serverHash: content.serverHash, serverId: content.serverId };
  // Tools of the widget server, so it can only call the ones visible to apps. Unchecked if they can not be listed
  let tools: Promise<Tool[] | undefined> | undefined;
  async function callTool(params: { name: string; arguments?: unknown }) {
    tools ??= chat
      .mcpRequest({ ...server, method: "tools/list" })
      .then((r) => (r as { tools: Tool[] }).tools)
      .catch(() => undefined);
    const list = await tools;
    const tool = list?.find((t) => t.name === params.name);
    if (list && !(tool?._meta?.ui?.visibility ?? ["model", "app"]).includes("app"))
      throw new Error(`Tool ${params.name} is not available to apps`);
    return chat.mcpRequest({ ...server, method: "tools/call", params });
  }
  const [ui] = createResource(() => loadUi(content, chat.mcpRequest));
  const [height, setHeight] = createSignal<number>();
  const [fullscreen, setFullscreen] = createSignal(false);
  // Name the MCP App gives itself on initialize, e.g. "GEO series explorer", else from the tool name
  const [appName, setAppName] = createSignal<string>();
  const caption = () => {
    const name = appName();
    if (name) return /\s/.test(name) ? name : humanize(name);
    return humanize(content.tool?.name ?? "") || "Interactive view";
  };
  let frame: HTMLIFrameElement | undefined;
  let rpcId = 0;
  const isApp = () => ui.state === "ready" && ui().kind === "app";

  const post = (message: unknown) => frame?.contentWindow?.postMessage(message, "*");
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const hostContext = () => ({
    theme: theme(chat),
    displayMode: fullscreen() ? "fullscreen" : "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    ...(fullscreen() && frame && { containerDimensions: { width: frame.clientWidth, height: frame.clientHeight } }),
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: "web",
    deviceCapabilities: { touch: matchMedia("(pointer: coarse)").matches, hover: matchMedia("(hover: hover)").matches },
  });
  const setMode = (mode: string) => {
    setFullscreen(mode === "fullscreen");
    // Once laid out, so the container size is known
    requestAnimationFrame(() => notify("ui/notifications/host-context-changed", hostContext()));
    return mode === "fullscreen" ? "fullscreen" : "inline";
  };

  // Tell the MCP App when the user switches theme
  createEffect(
    on(
      () => chat.state.theme,
      () => isApp() && notify("ui/notifications/host-context-changed", hostContext()),
      { defer: true },
    ),
  );

  /** Text sent by a widget as a user message, ignored while a response streams */
  const sendText = (text: string) => void chat.send(text);

  /** MCP App: JSON-RPC requests and notifications from the view */
  async function onRpc(msg: { id?: number | string; method?: string; params?: any }) {
    const { id, method, params } = msg;
    if (!method) return; // Response to a host request
    const reply = (result: unknown) => id !== undefined && post({ jsonrpc: "2.0", id, result });
    try {
      switch (method) {
        case "ui/initialize":
          setAppName(params?.appInfo?.title || params?.appInfo?.name);
          return reply({
            protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
            hostInfo: { name: "light-chat", version },
            hostCapabilities: {
              openLinks: {},
              serverTools: {},
              serverResources: {},
              logging: {},
              message: { text: {} },
              updateModelContext: { text: {}, structuredContent: {} },
            },
            hostContext: hostContext(),
          });
        case "ui/notifications/initialized":
          // Tool input then result, only once the view is initialized
          notify("ui/notifications/tool-input", { arguments: content.toolInput ?? {} });
          if (content.result) notify("ui/notifications/tool-result", content.result);
          return;
        case "ui/notifications/size-changed":
          // Ignored while full screen: the view then measures the screen, not its inline size
          if (params?.height && !fullscreen()) setHeight(Math.ceil(params.height));
          return;
        case "ui/open-link":
          window.open(params.url, "_blank", "noopener,noreferrer");
          return reply({});
        case "ui/message": {
          const blocks: { type: string; text?: string }[] = [params?.content ?? []].flat();
          sendText(blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
          return reply({});
        }
        case "ui/update-model-context":
          chat.setWidgetContext(props.part.id, params);
          return reply({});
        case "ui/request-display-mode":
          return reply({ mode: setMode(params?.mode) });
        case "tools/call":
          return reply(await callTool(params));
        case "resources/read":
          return reply(await chat.mcpRequest({ ...server, method, params }));
        case "ping":
          return reply({});
        default:
          // Other notifications (logging, teardown request) need no answer
          if (id !== undefined)
            post({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (id !== undefined) post({ jsonrpc: "2.0", id, error: { code: -32603, message } });
    }
  }

  /** MCP-UI: actions posted by the iframe, acknowledged then answered with their `messageId` */
  async function onMcpUi(msg: { type?: string; messageId?: string; payload?: any }) {
    const { type, messageId, payload = {} } = msg;
    const respond = (result: { response?: unknown; error?: unknown }) =>
      messageId && post({ type: "ui-message-response", messageId, payload: result });
    if (messageId) post({ type: "ui-message-received", messageId });
    try {
      switch (type) {
        case "ui-lifecycle-iframe-ready":
          return post({
            type: "ui-lifecycle-iframe-render-data",
            payload: { renderData: { toolInput: content.toolInput, theme: theme(chat), locale: navigator.language } },
          });
        case "ui-size-change":
          if (payload.height && !fullscreen()) setHeight(Math.ceil(payload.height));
          return;
        case "tool": {
          const params = { name: payload.toolName, arguments: payload.params ?? {} };
          return respond({ response: await callTool(params) });
        }
        case "prompt":
          sendText(payload.prompt);
          return respond({ response: {} });
        case "intent":
          sendText(`${payload.intent}${payload.params ? ` ${JSON.stringify(payload.params)}` : ""}`);
          return respond({ response: {} });
        case "link":
          window.open(payload.url, "_blank", "noopener,noreferrer");
          return respond({ response: {} });
      }
    } catch (err) {
      respond({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Messages are only accepted from this widget's iframe
  const onMessage = (e: MessageEvent) => {
    if (!frame || e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
    void (isApp() ? onRpc(e.data) : onMcpUi(e.data));
  };
  window.addEventListener("message", onMessage);
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    if (isApp())
      post({
        jsonrpc: "2.0",
        id: `teardown-${++rpcId}`,
        method: "ui/resource-teardown",
        params: { reason: "unmounted" },
      });
  });

  return (
    <div class="lc-widget-block">
      <div class="lc-widget-caption" title={content.tool?.name}>
        <AppIcon />
        <span>{caption()}</span>
      </div>
      <Switch>
        <Match when={ui.error}>
          <div class="lc-error">Could not load the UI: {ui.error?.message ?? String(ui.error)}</div>
        </Match>
        <Match when={ui.loading}>
          <div class="lc-widget-loading">Loading UI</div>
        </Match>
        <Match when={ui()?.kind === "unsupported" && ui()}>
          {(u) => (
            <div class="lc-widget-loading">Unsupported UI resource: {(u() as { mimeType: string }).mimeType}</div>
          )}
        </Match>
        <Match when={ui()}>
          {(u) => {
            const value = u();
            const app = value.kind === "app" ? value : undefined;
            return (
              <div
                class="lc-widget"
                classList={{
                  "lc-widget-border": app?.meta.prefersBorder !== false,
                  "lc-widget-fullscreen": fullscreen(),
                }}
              >
                <Show when={fullscreen()}>
                  <div class="lc-widget-bar">
                    <span class="lc-widget-caption">
                      <AppIcon />
                      <span>{caption()}</span>
                    </span>
                    <button
                      type="button"
                      class="lc-widget-close"
                      aria-label="Exit full screen"
                      onClick={() => setMode("inline")}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                </Show>
                <iframe
                  ref={frame}
                  title="Tool UI"
                  // External pages keep their own origin, HTML from tools runs in an opaque origin
                  sandbox={
                    value.kind === "url" ? "allow-scripts allow-same-origin allow-forms" : "allow-scripts allow-forms"
                  }
                  allow={app ? allowOf(app.meta.permissions) : undefined}
                  src={value.kind === "url" ? value.url : undefined}
                  srcdoc={app ? withCsp(app.html, app.meta.csp) : value.kind === "html" ? value.html : undefined}
                  // Fills the screen below the bar when full screen
                  style={{ height: fullscreen() ? undefined : `${height() ?? (app ? 160 : 400)}px` }}
                />
              </div>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}
