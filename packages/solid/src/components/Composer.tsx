import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import type { FilePart } from "../types.ts";
import { PlusIcon, ReturnIcon, StopIcon } from "./icons.tsx";
import { FileChip } from "./Parts.tsx";
import { ApiKeySetting, EffortSetting, McpServersSetting, ModelSetting } from "./Settings.tsx";

const readFile = (file: File) =>
  new Promise<FilePart>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({
        type: "file",
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data: reader.result as string,
      });
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

/**
 * Input box (attachments, auto-growing textarea, send), with a toolbar row under it (files, MCP servers, model, effort,
 * API key)
 */
export function Composer(props: { chat: ChatController; onSend: () => void }) {
  const { chat } = props;
  const [input, setInput] = createSignal("");
  const [files, setFiles] = createSignal<FilePart[]>([]);
  const attachments = chat.options.attachments !== false;
  const { config } = chat;
  let textarea!: HTMLTextAreaElement;
  let fileInput!: HTMLInputElement;

  const resize = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const addFiles = async (list: FileList | null | undefined) => {
    if (!list?.length) return;
    const read = await Promise.all([...list].map(readFile));
    setFiles((f) => [...f, ...read]);
  };

  const canSend = () => !!input().trim() || files().length > 0;

  const submit = () => {
    if (!canSend() || chat.state.streaming) return;
    props.onSend();
    void chat.send(input(), files());
    setInput("");
    setFiles([]);
    resize();
  };

  // Enter sends on desktop, on touch devices Enter inserts a new line
  const touch = matchMedia("(pointer: coarse)").matches;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touch) {
      e.preventDefault();
      submit();
    }
  };

  // Focus the input when a new empty conversation starts (skipped on touch to not pop the keyboard)
  createEffect(
    on(
      () => chat.state.conversationId,
      () => !touch && !chat.state.messages.length && textarea.focus(),
      { defer: true },
    ),
  );

  return (
    <form
      class="lc-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div class="lc-input">
        <Show when={files().length}>
          <div class="lc-attachments">
            <For each={files()}>
              {(file) => <FileChip file={file} onRemove={() => setFiles((f) => f.filter((x) => x !== file))} />}
            </For>
          </div>
        </Show>
        <div class="lc-input-row">
          <textarea
            ref={textarea}
            rows={1}
            value={input()}
            placeholder={chat.options.placeholder ?? "Send a message"}
            aria-label="Message"
            onInput={(e) => {
              setInput(e.currentTarget.value);
              resize();
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (attachments && e.clipboardData?.files.length) {
                e.preventDefault();
                void addFiles(e.clipboardData.files);
              }
            }}
          />
          <Show
            when={chat.state.streaming}
            fallback={
              <button type="submit" class="lc-send" disabled={!canSend()} aria-label="Send">
                <ReturnIcon />
              </button>
            }
          >
            <button type="button" class="lc-send" onClick={() => chat.stop()} aria-label="Stop">
              <StopIcon />
            </button>
          </Show>
        </div>
      </div>
      {/* Toolbar right under the input box: files and MCP servers on the left, enabled settings on the right */}
      <Show
        when={
          attachments || chat.options.mcpServers || config.models.length || chat.effortLevels().length || config.apiKey
        }
      >
        <div class="lc-toolbar">
          <Show when={attachments}>
            <button
              type="button"
              class="lc-icon-btn"
              aria-label="Add files"
              title="Add files"
              onClick={() => fileInput.click()}
            >
              <PlusIcon />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </Show>
          <Show when={chat.options.mcpServers}>{(source) => <McpServersSetting source={source()} />}</Show>
          {/* Settings on the right, API key at the edge */}
          <div class="lc-toolbar-settings">
            <Show when={config.models.length}>
              <ModelSetting chat={chat} />
            </Show>
            <Show when={chat.effortLevels().length}>
              <EffortSetting chat={chat} />
            </Show>
            <Show when={config.apiKey}>
              <ApiKeySetting chat={chat} />
            </Show>
          </div>
        </div>
      </Show>
    </form>
  );
}
