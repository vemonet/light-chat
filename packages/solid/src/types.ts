import type { Connector } from "./connectors/base.ts";
import type { HistoryStore } from "./history.ts";

export type Role = "user" | "assistant";
export type Rating = "up" | "down" | null;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
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

export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  /** Raw JSON arguments, accumulated while streaming */
  args: string;
  result?: string;
  status: "running" | "done";
}

export type Part = TextPart | ReasoningPart | ToolPart | FilePart;

export interface Message {
  id: string;
  role: Role;
  /** Ordered content blocks, text and tool calls can be interleaved */
  parts: Part[];
  createdAt: Date;
  rating?: Rating;
  error?: string;
}

/** Normalized stream events, every connector converts its backend stream to these */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool-start"; id: string; name: string }
  | { type: "tool-args"; id: string; delta: string }
  | { type: "tool-result"; id: string; result: unknown }
  | { type: "error"; message: string };

/** Values chosen by the user in the settings menu */
export interface ChatSettings {
  apiKey?: string;
  model?: string;
  effort?: string;
}

/** Where a setting value is put in the request, any combination of header, query and body */
export interface SettingTarget {
  /** HTTP header name, e.g. "Authorization" */
  header?: string;
  /** URL query parameter name */
  query?: string;
  /** Body key, dots for nested keys, e.g. "forwardedProps.model" */
  body?: string;
  /** Prepended to the value, e.g. "Bearer " */
  prefix?: string;
}

/** Target of each setting value, keyed like `ChatSettings` */
export type SettingTargets = Partial<Record<keyof ChatSettings, SettingTarget>>;

/** Selectable values of a setting, with an optional custom target */
export interface SettingValues extends SettingTarget {
  values: string[];
}

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
  theme?: "auto" | "light" | "dark";
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
   * Settings the user can change from the gear menu, saved in localStorage.
   * All disabled by default, the gear is hidden when none is enabled.
   */
  settings?: {
    /** Ask for an API key. Default target: `Authorization: Bearer <key>` header */
    apiKey?: boolean | SettingTarget;
    /** Models to choose from, the first one is the default. Default target defined by the connector */
    models?: string[] | SettingValues;
    /** Effort levels for a slider, the middle one is the default. Default target defined by the connector */
    effort?: string[] | SettingValues;
  };
  /** Enables thumbs up/down buttons under assistant messages */
  onRate?: (message: Message, rating: Rating) => void;
  onError?: (error: Error) => void;
}
