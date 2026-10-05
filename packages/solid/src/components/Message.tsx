import { createMemo, For, Index, Show } from "solid-js";
import type { ChatController } from "../store.ts";
import type { FilePart, Message, ReasoningPart, TextPart, ToolPart } from "../types.ts";
import { CheckIcon, CopyIcon, ThumbDownIcon, ThumbUpIcon } from "./icons.tsx";
import { copy, FileChip, Markdown, Steps } from "./Parts.tsx";

/** Assistant content block: markdown text, or consecutive thinking / tool call steps */
type Block = { kind: "text"; part: TextPart } | { kind: "steps"; steps: (ReasoningPart | ToolPart)[] };

/** Group parts in blocks. Whitespace-only text is skipped, so it neither adds a gap nor splits a group */
function toBlocks(message: Message): Block[] {
  const out: Block[] = [];
  for (const p of message.parts) {
    if (p.type === "text") {
      if (p.text.trim()) out.push({ kind: "text", part: p });
    } else if (p.type === "reasoning" || p.type === "tool") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(p);
      else out.push({ kind: "steps", steps: [p] });
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
const time = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 24h time for today's messages, `2026.12.28 · 23:12` otherwise */
const formatDate = (d: Date) => (d.toDateString() === new Date().toDateString() ? time(d) : `${day(d)} · ${time(d)}`);

/** Full date shown on hover: `2026.12.28 · 23:12:30` */
const formatFull = (d: Date) => `${day(d)} · ${time(d)}:${pad(d.getSeconds())}`;

export function MessageView(props: { message: Message; streaming: boolean; chat: ChatController }) {
  const m = () => props.message;
  const text = () =>
    m()
      .parts.map((p) => (p.type === "text" ? p.text : ""))
      .join("\n\n")
      .trim();
  const files = () => m().parts.filter((p): p is FilePart => p.type === "file");
  const blocks = createMemo(() => toBlocks(m()));

  return (
    <div class={`lc-msg lc-${m().role}`}>
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
          {/* Index keeps components mounted by position, blocks are recomputed but only appended */}
          <Index each={blocks()}>
            {(block, i) => (
              <Show
                when={block().kind === "steps"}
                fallback={<Markdown text={(block() as Extract<Block, { kind: "text" }>).part.text} />}
              >
                <Steps
                  steps={(block() as Extract<Block, { kind: "steps" }>).steps}
                  active={props.streaming && i === blocks().length - 1}
                />
              </Show>
            )}
          </Index>
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
          <time class="lc-time" dateTime={m().createdAt.toISOString()} title={formatFull(m().createdAt)}>
            {formatDate(m().createdAt)}
          </time>
        </div>
      </Show>
    </div>
  );
}
