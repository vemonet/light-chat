import { onCleanup } from "solid-js";
import { createChat, type ChatController } from "../store.ts";
import styles from "../styles.css?inline";
import type { ChatOptions } from "../types.ts";
import { App } from "./App.tsx";

export type ChatProps = ChatOptions & {
  /** Controller from `createChat()`, to drive the chat from code. Created from the props when omitted */
  controller?: ChatController;
};

/** Inject the stylesheet once per document, first in <head> so user styles take precedence */
function injectStyles() {
  if (document.getElementById("light-chat-styles")) return;
  const style = document.createElement("style");
  style.id = "light-chat-styles";
  style.textContent = styles;
  document.head.prepend(style);
}

/** Chat UI filling its parent. Options are read once when mounted */
export function Chat(props: ChatProps) {
  injectStyles();
  const chat = props.controller ?? createChat(props);
  if (!props.controller) onCleanup(() => chat.stopAll());
  return <App chat={chat} />;
}
