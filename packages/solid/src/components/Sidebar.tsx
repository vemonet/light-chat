import { createSignal, For, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import { PanelIcon, PlusIcon, TrashIcon } from "./icons.tsx";

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

/** Conversation history: new chat button and recent conversations, collapsible to two floating buttons */
export function Sidebar(props: { chat: ChatController }) {
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
            aria-label="New chat"
            title="New chat"
            onClick={newChat}
          >
            {newIcon()}
          </button>
        </div>
      }
    >
      <aside class="lc-sidebar" aria-label="Conversations">
        <button
          type="button"
          class="lc-sidebar-btn lc-square"
          aria-label="Close sidebar"
          title="Close sidebar"
          onClick={toggle}
        >
          <PanelIcon />
        </button>
        <button type="button" class="lc-sidebar-btn" title="New chat" onClick={newChat}>
          {newIcon()}
          <span>New</span>
        </button>
        <Show when={chat.state.conversations.length}>
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
