import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { JSX } from "solid-js";
import type { SearchHit } from "../history.ts";
import type { ChatController } from "../store.ts";
import type { Theme } from "../types.ts";
import { CloseIcon, MonitorIcon, MoonIcon, PanelIcon, PlusIcon, SearchIcon, SunIcon, TrashIcon } from "./icons.tsx";

const STORAGE_KEY = "light-chat-sidebar";
const narrow = () => matchMedia("(max-width: 700px)").matches;

/** Collapsed on narrow screens, otherwise the state the user left it in, or `sidebarOpen` on first visit */
function initialCollapsed(openByDefault: boolean) {
  if (narrow()) return true;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) return saved === "collapsed";
  } catch {
    // Storage unavailable
  }
  return !openByDefault;
}

/** Theme switch states, in click order */
const THEMES: Record<Theme, { label: string; icon: () => JSX.Element; next: Theme }> = {
  auto: { label: "System", icon: MonitorIcon, next: "light" },
  light: { label: "Light", icon: SunIcon, next: "dark" },
  dark: { label: "Dark", icon: MoonIcon, next: "auto" },
};

/** Text with every case-insensitive occurrence of `query` in a <mark> */
function Highlighted(props: { text: string; query: string }) {
  const pieces = () => {
    const lower = props.text.toLowerCase();
    const q = props.query.toLowerCase();
    const out: { text: string; match: boolean }[] = [];
    let from = 0;
    for (let i = lower.indexOf(q); q && i >= 0; i = lower.indexOf(q, from)) {
      out.push(
        { text: props.text.slice(from, i), match: false },
        { text: props.text.slice(i, i + q.length), match: true },
      );
      from = i + q.length;
    }
    out.push({ text: props.text.slice(from), match: false });
    return out;
  };
  return <For each={pieces()}>{(p) => (p.match ? <mark>{p.text}</mark> : p.text)}</For>;
}

/** Conversation history: new chat button, search and recent conversations, collapsible to two floating buttons */
export function Sidebar(props: {
  chat: ChatController;
  /** Called after a search hit's conversation is opened, to highlight the query in the message */
  onHit?: (messageId: string, query: string) => void;
}) {
  const { chat } = props;
  const [collapsed, setCollapsed] = createSignal(initialCollapsed(chat.options.sidebarOpen ?? false));

  const toggle = () => {
    setCollapsed(!collapsed());
    // On narrow screens the sidebar is a temporary overlay, its state is not remembered
    if (narrow()) return;
    try {
      localStorage.setItem(STORAGE_KEY, collapsed() ? "collapsed" : "open");
    } catch {
      // Storage unavailable
    }
  };
  // On narrow screens the open sidebar overlays the chat, close it after picking
  const done = () => narrow() && setCollapsed(true);

  const newChat = () => {
    void chat.newConversation();
    done();
  };
  // Search, the query is kept when search is toggled off and back on
  const store = chat.history;
  const canSearch = !!store?.search;
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [result, setResult] = createSignal<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  let searchInput!: HTMLInputElement;
  let searchRun = 0;

  // Search 150ms after typing stops, again when conversations change, only the latest run is shown
  createEffect(() => {
    const q = query().trim();
    void chat.state.conversations;
    if (!searching() || !q || !store?.search) return;
    const run = ++searchRun;
    const timer = setTimeout(async () => {
      try {
        const hits = await store.search!(q);
        if (run === searchRun) setResult({ query: q, hits });
      } catch (err) {
        chat.options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, 150);
    onCleanup(() => clearTimeout(timer));
  });
  const showHits = () => searching() && !!query().trim();

  const openHit = async (hit: SearchHit) => {
    await chat.openConversation(hit.conversationId);
    props.onHit?.(hit.messageId, result().query);
    done();
  };

  const newIcon = () => (
    <span class="lc-new-icon">
      <PlusIcon />
    </span>
  );

  return (
    <Show
      when={!collapsed()}
      fallback={
        // Collapsed: only the expand and new chat buttons, floating top left over the chat
        <div class="lc-sidebar-float">
          <button
            type="button"
            class="lc-sidebar-btn lc-square"
            aria-label="Open sidebar"
            title="Open sidebar"
            onClick={toggle}
          >
            <PanelIcon />
          </button>
          <button
            type="button"
            class="lc-sidebar-btn lc-square"
            aria-label="New session"
            title="New session"
            onClick={newChat}
          >
            {newIcon()}
          </button>
        </div>
      }
    >
      <aside class="lc-sidebar" aria-label="Conversations">
        <div class="lc-sidebar-top">
          <button
            type="button"
            class="lc-sidebar-btn lc-square"
            aria-label="Close sidebar"
            title="Close sidebar"
            onClick={toggle}
          >
            <PanelIcon />
          </button>
          {/* Theme switch, cycles system > light > dark */}
          <Show when={chat.options.themeSwitch}>
            <button
              type="button"
              class="lc-sidebar-btn lc-square"
              aria-label={`Theme: ${THEMES[chat.state.theme].label}`}
              title={`Theme: ${THEMES[chat.state.theme].label}`}
              onClick={() => chat.setTheme(THEMES[chat.state.theme].next)}
            >
              {THEMES[chat.state.theme].icon()}
            </button>
          </Show>
          {/* Search button, expands into a search box with a clear button */}
          <Show when={canSearch}>
            <div class="lc-search" classList={{ "lc-on": searching() }}>
              <button
                type="button"
                class="lc-sidebar-btn lc-square"
                aria-label={searching() ? "Close search" : "Search"}
                title={searching() ? "Close search" : "Search"}
                aria-pressed={searching()}
                onClick={() => setSearching(!searching())}
              >
                <SearchIcon />
              </button>
              <Show when={searching()}>
                <input
                  ref={(el) => {
                    searchInput = el;
                    queueMicrotask(() => el.focus());
                  }}
                  type="search"
                  placeholder="Search"
                  aria-label="Search conversations"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Escape" && setSearching(false)}
                />
                <Show when={query()}>
                  <button
                    type="button"
                    class="lc-search-clear"
                    aria-label="Clear search"
                    title="Clear search"
                    onClick={() => {
                      setQuery("");
                      searchInput.focus();
                    }}
                  >
                    <CloseIcon />
                  </button>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
        <button type="button" class="lc-sidebar-btn" title="New session" onClick={newChat}>
          {newIcon()}
          <span>New</span>
        </button>
        {/* Search results, one row per matching message */}
        <Show when={showHits()}>
          <div class="lc-recents">
            {result().hits.length
              ? `${result().hits.length} result${result().hits.length > 1 ? "s" : ""}`
              : result().query === query().trim()
                ? "No results"
                : "Searching..."}
          </div>
          <nav class="lc-conversations">
            <For each={result().hits}>
              {(hit) => (
                <button
                  type="button"
                  class="lc-hit"
                  classList={{ "lc-current": hit.conversationId === chat.state.conversationId }}
                  onClick={() => void openHit(hit)}
                >
                  <span class="lc-hit-title">{hit.title}</span>
                  <span class="lc-hit-snippet">
                    <Highlighted text={hit.snippet} query={result().query} />
                  </span>
                </button>
              )}
            </For>
          </nav>
        </Show>
        <Show when={!showHits() && chat.state.conversations.length}>
          <div class="lc-recents">Recents</div>
          <nav class="lc-conversations">
            <For each={chat.state.conversations}>
              {(c) => (
                <div class="lc-conversation" classList={{ "lc-current": c.id === chat.state.conversationId }}>
                  <button
                    type="button"
                    class="lc-conversation-title"
                    title={c.title}
                    onClick={() => {
                      void chat.openConversation(c.id);
                      done();
                    }}
                  >
                    {c.title}
                  </button>
                  {/* Response still streaming, e.g. after switching to another conversation */}
                  <Show when={chat.state.threads[c.id]?.streaming}>
                    <span class="lc-conversation-running" role="status" aria-label="Responding" title="Responding" />
                  </Show>
                  <button
                    type="button"
                    class="lc-conversation-delete"
                    aria-label={`Delete ${c.title}`}
                    title="Delete"
                    onClick={() => void chat.deleteConversation(c.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              )}
            </For>
          </nav>
        </Show>
      </aside>
      {/* Tap outside the overlaying sidebar to close it (narrow screens only, see CSS) */}
      <div class="lc-backdrop" onClick={() => setCollapsed(true)} />
    </Show>
  );
}
