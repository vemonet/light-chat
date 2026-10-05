import { createSignal, For, Show, type JSX } from "solid-js";
import { highlight, renderMarkdown } from "../markdown.ts";
import type { FilePart, ReasoningPart, ToolPart } from "../types.ts";
import { BulbIcon, ChevronIcon, CloseIcon, FileIcon, ToolIcon } from "./icons.tsx";

/** Copy to clipboard and briefly flag the element with `data-copied` for feedback */
export function copy(text: string, el: HTMLElement) {
  void navigator.clipboard?.writeText(text);
  el.dataset.copied = "";
  setTimeout(() => delete el.dataset.copied, 1500);
}

export function Markdown(props: { text: string }) {
  // Code block copy buttons are plain HTML, handled by event delegation
  const onClick = (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".lc-code-copy");
    const code = btn?.closest(".lc-code")?.querySelector("code");
    if (btn && code) copy(code.textContent ?? "", btn);
  };
  return <div class="lc-md" innerHTML={renderMarkdown(props.text)} onClick={onClick} />;
}

/** Collapsible row used for tool calls and reasoning, content only rendered when open */
function Collapsible(props: { icon: JSX.Element; label: JSX.Element; active?: boolean; children: () => JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <details
      class="lc-collapsible"
      classList={{ "lc-active": props.active }}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span class="lc-collapsible-icon">{props.icon}</span>
        <span class="lc-collapsible-label">{props.label}</span>
        <span class="lc-chevron">
          <ChevronIcon />
        </span>
      </summary>
      <Show when={open()}>
        <div class="lc-collapsible-body">{props.children()}</div>
      </Show>
    </details>
  );
}

/** Pretty print JSON when it parses (partial args while streaming stay raw) */
function Code(props: { value: string }) {
  const html = () => {
    try {
      return highlight(JSON.stringify(JSON.parse(props.value), null, 2), "json");
    } catch {
      return highlight(props.value);
    }
  };
  return (
    <pre class="lc-tool-code">
      <code class="hljs" innerHTML={html()} />
    </pre>
  );
}

/** Readable tool name: get_weather or getWeather become "Get weather" */
const humanize = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function ToolCall(props: { part: ToolPart }) {
  return (
    <Collapsible
      icon={<ToolIcon />}
      active={props.part.status === "running"}
      label={humanize(props.part.name) || "Tool"}
    >
      {() => (
        <>
          <code class="lc-tool-fn">{props.part.name}</code>
          <div class="lc-tool-label">Arguments</div>
          <Code value={props.part.args || "{}"} />
          <Show when={props.part.result !== undefined}>
            <div class="lc-tool-label">Result</div>
            <Code value={props.part.result!} />
          </Show>
        </>
      )}
    </Collapsible>
  );
}

export function Reasoning(props: { part: ReasoningPart; active: boolean }) {
  return (
    <Collapsible icon={<BulbIcon />} active={props.active} label={props.active ? "Thinking" : "Thought process"}>
      {() => <div class="lc-reasoning">{props.part.text}</div>}
    </Collapsible>
  );
}

/** Attached file: thumbnail for images, icon and name otherwise. Removable in the composer */
export function FileChip(props: { file: FilePart; onRemove?: () => void }) {
  const image = () => props.file.mimeType.startsWith("image/");
  return (
    <div class="lc-file" classList={{ "lc-file-image": image() }} title={props.file.name}>
      <Show
        when={image()}
        fallback={
          <>
            <FileIcon />
            <span class="lc-file-name">{props.file.name}</span>
          </>
        }
      >
        <img src={props.file.data} alt={props.file.name} />
      </Show>
      <Show when={props.onRemove}>
        <button
          type="button"
          class="lc-file-remove"
          aria-label={`Remove ${props.file.name}`}
          onClick={() => props.onRemove?.()}
        >
          <CloseIcon />
        </button>
      </Show>
    </div>
  );
}

type Step = ReasoningPart | ToolPart;

function StepView(props: { part: Step; active: boolean }) {
  return props.part.type === "tool" ? (
    <ToolCall part={props.part} />
  ) : (
    <Reasoning part={props.part} active={props.active} />
  );
}

/** Label shown on a collapsed group once done, e.g. "Thought process · 2 tool calls" */
function summary(steps: Step[]) {
  const tools = steps.filter((s) => s.type === "tool").length;
  const toolsLabel = `${tools} tool call${tools > 1 ? "s" : ""}`;
  if (!tools) return "Thought process";
  return steps.length > tools ? `Thought process · ${toolsLabel}` : toolsLabel;
}

/**
 * Consecutive thinking and tool call steps. A single step is shown as is, several are grouped in one line
 * showing the running step (or a summary when done), expanding to the list of steps.
 */
export function Steps(props: { steps: Step[]; active: boolean }) {
  const last = () => props.steps[props.steps.length - 1];
  const runningLabel = () => {
    const step = last();
    return step.type === "tool" ? humanize(step.name) || "Tool" : "Thinking";
  };
  return (
    <Show when={props.steps.length > 1} fallback={<StepView part={props.steps[0]} active={props.active} />}>
      <Collapsible
        icon={props.steps.some((s) => s.type === "tool") ? <ToolIcon /> : <BulbIcon />}
        active={props.active}
        label={props.active ? runningLabel() : summary(props.steps)}
      >
        {() => (
          <div class="lc-steps">
            <For each={props.steps}>
              {(step, i) => <StepView part={step} active={props.active && i() === props.steps.length - 1} />}
            </For>
          </div>
        )}
      </Collapsible>
    </Show>
  );
}
