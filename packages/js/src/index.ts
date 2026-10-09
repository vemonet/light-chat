import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import {
  Chat as ChatComponent,
  createChat,
  type ChatController,
  type ChatOptions,
  type FilePart,
  type Message,
} from "light-chat-solid";

// Only the data types, the Solid component types would pull in all of Solid's JSX types
export type {
  ActivityPart,
  AgUiConnectorOptions,
  AgUiEvent,
  ApplySetting,
  ChatEvent,
  ChatOptions,
  ChatRequest,
  ChatSettings,
  Connector,
  ConnectorContext,
  Conversation,
  ConversationSummary,
  FilePart,
  HistoryStore,
  HttpConnectorOptions,
  McpRequest,
  Message,
  Part,
  Rating,
  ReasoningPart,
  RequestContext,
  SearchHit,
  Role,
  SettingAppliers,
  StepPart,
  SubagentPart,
  TextPart,
  Timing,
  ToolPart,
  Turn,
} from "light-chat-solid";
export {
  AgUiConnector,
  HttpConnector,
  IndexedDBHistory,
  OpenAIConnector,
  searchConversations,
  sse,
  toTurns,
} from "light-chat-solid";

/** Framework agnostic chat UI, wraps the Solid component */
export class Chat {
  #chat: ChatController;
  #dispose: () => void;

  /**
   * @param target element or element id to render the chat into, it fills the element
   * @param options backend and UI options
   */
  constructor(target: string | HTMLElement, options: ChatOptions = {}) {
    const el = typeof target === "string" ? document.getElementById(target.replace(/^#/, "")) : target;
    if (!el) throw new Error(`light-chat: element "${target as string}" not found`);
    this.#chat = createChat(options);
    this.#dispose = render(() => createComponent(ChatComponent, { controller: this.#chat }), el);
  }

  /** Current conversation */
  get messages(): Message[] {
    return this.#chat.state.messages;
  }

  /** Send a user message, optionally with files, and stream the response */
  send(text: string, files?: FilePart[]): Promise<void> {
    return this.#chat.send(text, files);
  }

  /** Abort the response being streamed */
  stop(): void {
    this.#chat.stop();
  }

  /** Start a new conversation */
  clear(): Promise<void> {
    return this.#chat.newConversation();
  }

  /** Open a conversation from the history */
  open(id: string): Promise<void> {
    return this.#chat.openConversation(id);
  }

  /** Id of the current conversation, also sent as AG-UI thread id */
  get conversationId(): string {
    return this.#chat.state.conversationId;
  }

  /** Unmount the UI */
  destroy(): void {
    this.#chat.stop();
    this.#dispose();
  }
}
