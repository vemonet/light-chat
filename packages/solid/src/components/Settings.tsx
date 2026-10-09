import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { ChatController } from "../store.ts";
import { CheckIcon, ChevronIcon, EyeIcon, EyeOffIcon, GaugeIcon, KeyIcon } from "./icons.tsx";

/** Toolbar button toggling a popover above it, closed on click outside or Escape */
function Popover(props: {
  label: string;
  /** Button class, default icon button */
  class?: string;
  trigger: JSX.Element;
  children: (close: () => void) => JSX.Element;
}) {
  const [open, setOpen] = createSignal(false);
  const close = () => setOpen(false);
  let root!: HTMLDivElement;

  createEffect(() => {
    if (!open()) return;
    const onPointer = (e: PointerEvent) => !root.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="lc-setting" ref={root}>
      <button
        type="button"
        class={props.class ?? "lc-icon-btn"}
        classList={{ "lc-on": open() }}
        aria-label={props.label}
        aria-expanded={open()}
        title={props.label}
        onClick={() => setOpen(!open())}
      >
        {props.trigger}
      </button>
      <Show when={open()}>
        <div class="lc-popover" role="dialog" aria-label={props.label}>
          {props.children(close)}
        </div>
      </Show>
    </div>
  );
}

/** Current model as label, a menu of models opens when clicked */
export function ModelSetting(props: { chat: ChatController }) {
  const { chat } = props;
  return (
    <Popover
      label="Model"
      class="lc-chip-btn"
      trigger={
        <>
          <span>{chat.settings.model}</span>
          <ChevronIcon />
        </>
      }
    >
      {(close) => (
        <div class="lc-menu" role="menu">
          <For each={chat.config.models}>
            {(m) => (
              <button
                type="button"
                class="lc-menu-item"
                role="menuitemradio"
                aria-checked={m === chat.settings.model}
                onClick={() => {
                  chat.setSetting("model", m);
                  close();
                }}
              >
                <span>{m}</span>
                <Show when={m === chat.settings.model}>
                  <CheckIcon />
                </Show>
              </button>
            )}
          </For>
        </div>
      )}
    </Popover>
  );
}

/** Button opening a slider to pick the effort level */
export function EffortSetting(props: { chat: ChatController }) {
  const { chat } = props;
  const effort = chat.config.effort;
  return (
    <Popover label={`Effort: ${chat.settings.effort}`} trigger={<GaugeIcon />}>
      {() => (
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
      )}
    </Popover>
  );
}

/** Button opening a password input for the API key, with an eye toggle to show it. Enter closes it */
export function ApiKeySetting(props: { chat: ChatController }) {
  const { chat } = props;
  const [visible, setVisible] = createSignal(false);
  return (
    <Popover label="API key" trigger={<KeyIcon />}>
      {(close) => (
        <label class="lc-field">
          <span class="lc-field-label">API key</span>
          <div class="lc-secret">
            <input
              ref={(el) => queueMicrotask(() => el.focus())}
              type={visible() ? "text" : "password"}
              autocomplete="off"
              spellcheck={false}
              placeholder="Paste your key"
              value={chat.settings.apiKey ?? ""}
              onInput={(e) => chat.setSetting("apiKey", e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                // Not submitting the message form
                e.preventDefault();
                close();
              }}
            />
            <button
              type="button"
              class="lc-icon-btn"
              aria-label={visible() ? "Hide API key" : "Show API key"}
              title={visible() ? "Hide API key" : "Show API key"}
              onClick={() => setVisible(!visible())}
            >
              {visible() ? <EyeOffIcon /> : <EyeIcon />}
            </button>
          </div>
        </label>
      )}
    </Popover>
  );
}
