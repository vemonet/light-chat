import type { Connector } from "./connectors/base.ts";
import type { HistoryStore } from "./history.ts";

export type Role = "user" | "assistant";
export type Rating = "up" | "down" | null;

export interface TextPart {
  type: "text";
  text: string;
}

/** Start and end of a thinking or tool call step, epoch ms. End is unset while running */
export interface Timing {
  startedAt?: number;
  endedAt?: number;
}

export interface ReasoningPart extends Timing {
  type: "reasoning";
  text: string;
}

/** File attached to a user message */
export interface FilePart {
  type: "file";
  name: string;
  mimeType: string;
  /** Base64 data URL */
  data: string;
}

export interface ToolPart extends Timing {
  type: "tool";
  id: string;
  name: string;
  /** MCP server providing the tool, shown before its name */
  server?: string;
  /** Raw JSON arguments, accumulated while streaming */
  args: string;
  result?: string;
  status: "running" | "done";
}

/** Named step of the agent run, e.g. a graph node */
export interface StepPart extends Timing {
  type: "step";
  name: string;
  status: "running" | "done";
}

/** Sub-agent run, its own text and steps are streamed inside */
export interface SubagentPart extends Timing {
  type: "subagent";
  id: string;
  name: string;
  description?: string;
  parts: Part[];
  status: "running" | "done" | "error";
  result?: string;
  error?: string;
}

/** Structured progress update from the agent, e.g. a plan or a search status, replaced as it changes */
export interface ActivityPart {
  type: "activity";
  id: string;
  /** Kind of activity, e.g. "PLAN" */
  activityType: string;
  content: unknown;
  /** Context set by a widget for the model (MCP Apps `ui/update-model-context`), sent with the next requests */
  context?: unknown;
}

export type Part = TextPart | ReasoningPart | ToolPart | FilePart | StepPart | SubagentPart | ActivityPart;

export interface Message {
  id: string;
  role: Role;
  /** Ordered content blocks, text and tool calls can be interleaved */
  parts: Part[];
  createdAt: Date;
  /** When an assistant response finished streaming, epoch ms */
  endedAt?: number;
  rating?: Rating;
  error?: string;
  /** Agent shared state at the end of the response (AG-UI), sent back with the next request */
  state?: unknown;
}

/**
 * Normalized stream events, every connector converts its backend stream to these.
 * `subagent` is the id of the sub-agent run the event comes from, unset for the main agent.
 */
export type ChatEvent = (
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-start"; id: string; name: string; server?: string }
  | { type: "tool-args"; id: string; delta: string }
  | { type: "tool-result"; id: string; result: unknown }
  | { type: "step-start"; name: string }
  | { type: "step-end"; name: string }
  | { type: "subagent-start"; id: string; name: string; description?: string }
  | { type: "subagent-end"; id: string; result?: unknown; error?: string }
  | { type: "activity"; id: string; activityType: string; content: unknown }
  | { type: "state"; state: unknown }
  | { type: "error"; message: string }
) & { subagent?: string };

/** MCP request sent by a widget to the server of its tool, proxied by the backend */
export interface McpRequest {
  /** Server of the tool, from the `mcp-apps` activity */
  serverHash?: string;
  serverId?: string;
  method: string;
  params?: Record<string, unknown>;
}

/** Values chosen by the user in the toolbar under the input box */
export interface ChatSettings {
  apiKey?: string;
  model?: string;
  effort?: string;
}

/** Request built by a connector, setting callbacks can change it before it is sent */
export interface ChatRequest {
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Add a setting value to the request, e.g. `(req, model) => (req.body.model = model)` */
export type ApplySetting = (req: ChatRequest, value: string) => void;

/** Callback of each setting, keyed like `ChatSettings` */
export type SettingAppliers = Partial<Record<keyof ChatSettings, ApplySetting>>;

/** Model in the settings menu, with the effort levels of the slider shown when it is picked */
export interface ModelOption {
  name: string;
  /** Effort levels, lowest first, e.g. `["none", "low", "high"]`. No effort slider when empty */
  effort?: string[];
  /** Default effort level. Default: the middle one */
  defaultEffort?: string;
}

/** MCP server used by the agent, listed with its number of tools in the toolbar */
export interface McpServerInfo {
  id: string;
  /** Endpoint of the server, relative to the URL the list was fetched from */
  url?: string;
  /** Number of tools, null when the server is unavailable */
  tools?: number | null;
}

/** "auto" follows the OS preference */
export type Theme = "auto" | "light" | "dark";

export interface ChatOptions {
  /** Backend connector, e.g. `new OpenAIConnector({ url })`. Default: AG-UI connector on `url` */
  connector?: Connector;
  /** Endpoint of the default AG-UI connector, ignored when `connector` is set */
  url?: string;
  /** Markdown shown when the conversation is empty */
  welcome?: string;
  /** Example questions shown under the welcome message, sent when clicked */
  examples?: string[];
  placeholder?: string;
  /** Default "auto" follows the OS preference */
  theme?: Theme;
  /** Show a button in the sidebar to switch between system, light and dark theme, saved in localStorage. Default: false */
  themeSwitch?: boolean;
  /**
   * MCP servers used by the agent, listed with their number of tools from a button in the toolbar. Either the list,
   * or the URL of a JSON object with a `mcpServers` list, fetched once and relative to the page like `url`
   */
  mcpServers?: McpServerInfo[] | string;
  /** Show the + button to attach files to messages. Default: true */
  attachments?: boolean;
  /**
   * Conversation history in a sidebar. Default: true, stored in IndexedDB.
   * Pass a `HistoryStore` to use your own API or database, or false to disable.
   */
  history?: boolean | HistoryStore;
  /** Open the history sidebar on the first visit, then the user choice is remembered. Default: false */
  sidebarOpen?: boolean;
  /**
   * URL query parameter holding the open conversation id, e.g. `?session=ID`, opened on page load.
   * Only used with the history. Default: "session", false to leave the URL unchanged.
   */
  urlParam?: string | false;
  /**
   * Settings the user can change in the toolbar under the input box, saved in localStorage.
   * All disabled by default. `apply` replaces how the connector adds the value to the request.
   */
  settings?: {
    /** Ask for an API key. Default: `Authorization: Bearer <key>` header */
    apiKey?: boolean | { apply?: ApplySetting };
    /**
     * Models to choose from, the first one is the default. Models with `effort` levels show an effort slider.
     * Default apply defined by the connector
     */
    models?: (string | ModelOption)[] | { values: (string | ModelOption)[]; apply?: ApplySetting };
    /** How the effort level of the picked model is added to the request. Default defined by the connector */
    effort?: { apply?: ApplySetting };
  };
  /** Enables thumbs up/down buttons under assistant messages */
  onRate?: (message: Message, rating: Rating) => void;
  onError?: (error: Error) => void;
}
