import { createMemo, For, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import type { FilePart, Message } from "../types.ts";
import { CheckIcon, CopyIcon, ThumbDownIcon, ThumbUpIcon } from "./icons.tsx";
import { Blocks, copy, Elapsed, FileChip, formatDuration, toBlocks } from "./Parts.tsx";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 24h time for today's messages, `2026.12.28 · 23:12` otherwise */
const formatDate = (d: Date) => (d.toDateString() === new Date().toDateString() ? time(d) : `${day(d)} · ${time(d)}`);

/** Full date shown on hover, with the generation time when known: `2026.12.28 · 23:12:30 in 1m12s` */
const formatFull = (d: Date, endedAt?: number) =>
  `${day(d)} · ${time(d)}:${pad(d.getSeconds())}` + (endedAt ? ` in ${formatDuration(endedAt - d.getTime())}` : "");

export function MessageView(props: { message: Message; streaming: boolean; chat: ChatController }) {
  const m = () => props.message;
  const text = () =>
    m()
      .parts.map((p) => (p.type === "text" ? p.text : ""))
      .join("\n\n")
      .trim();
  const files = () => m().parts.filter((p): p is FilePart => p.type === "file");
  const blocks = createMemo(() => toBlocks(m().parts));

  return (
    <div class={`lc-msg lc-${m().role}`} data-id={m().id}>
      <Show
        when={m().role === "assistant"}
        fallback={
          <>
            <Show when={files().length}>
              <div class="lc-attachments">
                <For each={files()}>{(file) => <FileChip file={file} />}</For>
              </div>
            </Show>
            <Show when={text()}>
              <div class="lc-bubble">{text()}</div>
            </Show>
          </>
        }
      >
        <div class="lc-content">
          <Blocks blocks={blocks()} active={props.streaming} />
          <Show when={props.streaming && !blocks().length}>
            <div class="lc-dots" aria-label="Loading">
              <span />
              <span />
              <span />
            </div>
          </Show>
          <Show when={m().error}>
            <div class="lc-error">{m().error}</div>
          </Show>
        </div>
      </Show>

      {/* Time elapsed while the response streams, hidden while a steps line shows its own timer */}
      <Show when={props.streaming && blocks()[blocks().length - 1]?.kind !== "steps"}>
        <Elapsed class="lc-msg-elapsed" start={m().createdAt.getTime()} />
      </Show>

      {/* Actions revealed on hover: copy, datetime, rating */}
      <Show when={!props.streaming}>
        <div class="lc-actions">
          <button
            type="button"
            class="lc-action lc-copy"
            title="Copy"
            aria-label="Copy message"
            onClick={(e) => copy(text(), e.currentTarget)}
          >
            <CopyIcon />
            <CheckIcon />
          </button>
          <Show when={m().role === "assistant" && props.chat.options.onRate}>
            <button
              type="button"
              class="lc-action"
              classList={{ "lc-selected": m().rating === "up" }}
              title="Good response"
              aria-label="Good response"
              aria-pressed={m().rating === "up"}
              onClick={() => props.chat.rate(m().id, "up")}
            >
              <ThumbUpIcon />
            </button>
            <button
              type="button"
              class="lc-action"
              classList={{ "lc-selected": m().rating === "down" }}
              title="Bad response"
              aria-label="Bad response"
              aria-pressed={m().rating === "down"}
              onClick={() => props.chat.rate(m().id, "down")}
            >
              <ThumbDownIcon />
            </button>
          </Show>
          <time class="lc-time" dateTime={m().createdAt.toISOString()} title={formatFull(m().createdAt, m().endedAt)}>
            {formatDate(m().createdAt)}
          </time>
        </div>
      </Show>
    </div>
  );
}
