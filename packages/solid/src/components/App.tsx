import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { MessageView } from "./Message.tsx";
import { Markdown } from "./Parts.tsx";

export function App(props: { chat: ChatController }) {
  const { chat } = props;
  let scroller!: HTMLDivElement;
  let thread!: HTMLDivElement;
  // Follow streamed content only while the user is at the bottom
  let stick = true;

  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (stick && chat.state.streaming) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(thread);
    onCleanup(() => observer.disconnect());
  });

  // Show the end of a conversation when opening it
  createEffect(
    on(
      () => chat.state.conversationId,
      () => {
        stick = true;
        requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
      },
      { defer: true },
    ),
  );

  const theme = chat.options.theme ?? "auto";

  return (
    <div class="lc-root" style={{ "color-scheme": theme === "auto" ? "light dark" : theme }}>
      <Show when={chat.history}>
        <Sidebar chat={chat} />
      </Show>
      <div class="lc-main">
        <div
          class="lc-scroll"
          ref={scroller}
          onScroll={() => (stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40)}
        >
          <div class="lc-thread" ref={thread}>
            <Show
              when={chat.state.messages.length}
              fallback={
                <div class="lc-welcome">
                  <Markdown text={chat.options.welcome ?? "## How can I help you today?"} />
                  {/* Example questions, sent when clicked */}
                  <Show when={chat.options.examples?.length}>
                    <div class="lc-examples">
                      <For each={chat.options.examples}>
                        {(question) => (
                          <button type="button" class="lc-example" onClick={() => void chat.send(question)}>
                            {question}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              }
            >
              <For each={chat.state.messages}>
                {(message, i) => (
                  <MessageView
                    message={message}
                    chat={chat}
                    streaming={chat.state.streaming && i() === chat.state.messages.length - 1}
                  />
                )}
              </For>
            </Show>
          </div>
        </div>

        <Composer chat={chat} onSend={() => (stick = true)} />
      </div>
    </div>
  );
}
