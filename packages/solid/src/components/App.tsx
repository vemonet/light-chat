import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ChatContext, type ChatController } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { MessageView } from "./Message.tsx";
import { Markdown } from "./Parts.tsx";

const HIGHLIGHT = "lc-search";

/** Ranges of every case-insensitive occurrence of `query` in the text under `root` */
function findRanges(root: Node, query: string) {
  const q = query.toLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toLowerCase();
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + q.length);
      ranges.push(range);
    }
  }
  return ranges;
}

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

    // New session shortcut: Cmd/Ctrl+Shift+O, and Cmd/Ctrl+N where the browser lets the page catch it
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if ((key === "n" && !e.shiftKey) || (key === "o" && e.shiftKey)) {
        e.preventDefault();
        void chat.newConversation();
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey);
    });
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

  // Search hit: highlight the query in the message with the CSS Highlight API, centered in the thread
  const clearHighlight = () => globalThis.CSS?.highlights?.delete(HIGHLIGHT);
  const highlight = (messageId: string, query: string) =>
    // After the scroll to the end done when a conversation opens
    requestAnimationFrame(() => {
      const el = thread.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
      if (!el) return;
      const ranges = findRanges(el, query);
      if (globalThis.CSS?.highlights) CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
      // First visible match, or the message when the match is hidden (e.g. collapsed) or not in the rendered text
      const rect = ranges.map((r) => r.getBoundingClientRect()).find((r) => r.height) ?? el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top + rect.height / 2 - (view.top + view.height / 2);
    });
  // Highlights are cleared when switching conversation or sending a message
  createEffect(
    on([() => chat.state.conversationId, () => chat.state.messages.length], clearHighlight, { defer: true }),
  );
  onCleanup(clearHighlight);

  // Keep the open conversation id in the URL (?session=ID), and open the one given in the URL on load
  const param = chat.options.urlParam ?? "session";
  if (chat.history && param) {
    const [loaded, setLoaded] = createSignal(false);
    onMount(async () => {
      const id = new URL(location.href).searchParams.get(param);
      if (id) await chat.openConversation(id);
      setLoaded(true);
    });
    createEffect(() => {
      if (!loaded()) return;
      // A new conversation is only in the URL once it has messages
      const id = chat.state.messages.length ? chat.state.conversationId : null;
      const url = new URL(location.href);
      if (url.searchParams.get(param) === id) return;
      if (id) url.searchParams.set(param, id);
      else url.searchParams.delete(param);
      window.history.replaceState(window.history.state, "", url);
    });
  }

  const theme = chat.options.theme ?? "auto";

  return (
    <ChatContext.Provider value={chat}>
      <div class="lc-root" style={{ "color-scheme": theme === "auto" ? "light dark" : theme }}>
        <Show when={chat.history}>
          <Sidebar chat={chat} onHit={highlight} />
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
    </ChatContext.Provider>
  );
}
