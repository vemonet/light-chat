import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import { GearIcon } from "./icons.tsx";

/** Gear button opening a popover with the enabled settings, changes are saved right away */
export function Settings(props: { chat: ChatController }) {
  const { chat } = props;
  const { config } = chat;
  const effort = config.effort;
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;

  // Close on click outside or Escape
  createEffect(() => {
    if (!open()) return;
    const onPointer = (e: PointerEvent) => !root.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="lc-settings" ref={root}>
      <button
        type="button"
        class="lc-icon-btn"
        classList={{ "lc-on": open() }}
        aria-label="Settings"
        aria-expanded={open()}
        title="Settings"
        onClick={() => setOpen(!open())}
      >
        <GearIcon />
      </button>
      <Show when={open()}>
        <div class="lc-popover" role="dialog" aria-label="Settings">
          <Show when={config.models.length}>
            <label class="lc-field">
              <span class="lc-field-label">Model</span>
              <select onChange={(e) => chat.setSetting("model", e.currentTarget.value)}>
                <For each={config.models}>
                  {(m) => (
                    <option value={m} selected={m === chat.settings.model}>
                      {m}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <Show when={effort.length}>
            <label class="lc-field">
              <span class="lc-field-label">
                Effort <span class="lc-field-value">{chat.settings.effort}</span>
              </span>
              <input
                type="range"
                min="0"
                max={effort.length - 1}
                step="1"
                value={effort.indexOf(chat.settings.effort ?? "")}
                onInput={(e) => chat.setSetting("effort", effort[Number(e.currentTarget.value)])}
              />
              <span class="lc-ticks">
                <For each={effort}>{(v) => <span>{v}</span>}</For>
              </span>
            </label>
          </Show>
          <Show when={config.apiKey}>
            <label class="lc-field">
              <span class="lc-field-label">API key</span>
              <input
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="Paste your key"
                value={chat.settings.apiKey ?? ""}
                onInput={(e) => chat.setSetting("apiKey", e.currentTarget.value)}
              />
            </label>
          </Show>
        </div>
      </Show>
    </div>
  );
}
