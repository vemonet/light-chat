import { createMemo, createSignal, For, Index, Match, onCleanup, Show, Switch, type JSX } from "solid-js";
import { highlight, renderMarkdown } from "../markdown.ts";
import type {
  ActivityPart,
  FilePart,
  Part,
  ReasoningPart,
  StepPart,
  SubagentPart,
  TextPart,
  Timing,
  ToolPart,
} from "../types.ts";
import { ActivityIcon, AgentIcon, BulbIcon, ChevronIcon, CloseIcon, FileIcon, StepIcon, ToolIcon } from "./icons.tsx";
import { hasUi, Widget, WIDGET_ACTIVITY } from "./Widget.tsx";

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

/** Duration as 12s, 1m12s or 1h2m */
export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
};

/** Time elapsed since `start`, ticking every second until `end` is set. Nothing shown without start */
export function Elapsed(props: { start?: number; end?: number; class?: string }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => props.end === undefined && setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  return (
    <Show when={props.start}>
      {(start) => <span class={props.class ?? "lc-elapsed"}>{formatDuration((props.end ?? now()) - start())}</span>}
    </Show>
  );
}

/** Collapsible row used for tool calls and reasoning, content only rendered when open */
function Collapsible(props: {
  icon: JSX.Element;
  label: JSX.Element;
  active?: boolean;
  timing?: Timing;
  children: () => JSX.Element;
}) {
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
        <Elapsed start={props.timing?.startedAt} end={props.timing?.endedAt} />
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

/** Row without details, aligned with collapsible rows */
function Row(props: { icon: JSX.Element; label: JSX.Element; active?: boolean; timing?: Timing }) {
  return (
    <div class="lc-collapsible" classList={{ "lc-active": props.active }}>
      <div class="lc-row">
        <span class="lc-collapsible-icon">{props.icon}</span>
        <span class="lc-collapsible-label">{props.label}</span>
        <Elapsed start={props.timing?.startedAt} end={props.timing?.endedAt} />
      </div>
    </div>
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
      timing={props.part}
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
    <Collapsible
      icon={<BulbIcon />}
      active={props.active}
      timing={props.part}
      label={props.active ? "Thinking" : "Thought process"}
    >
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

/** Named step of the agent run, e.g. a graph node */
export function StepRow(props: { part: StepPart }) {
  return (
    <Row
      icon={<StepIcon />}
      active={props.part.status === "running"}
      timing={props.part}
      label={humanize(props.part.name) || "Step"}
    />
  );
}

/** Activity title from its content, or its type: PLAN_UPDATE becomes "Plan update" */
const activityLabel = (a: ActivityPart) => {
  const title = (a.content as { title?: unknown } | null)?.title;
  return typeof title === "string" ? title : humanize(a.activityType.toLowerCase()) || "Activity";
};

/** Activity update, its latest content shown when expanded */
export function Activity(props: { part: ActivityPart }) {
  return (
    <Collapsible icon={<ActivityIcon />} label={activityLabel(props.part)}>
      {() => <Code value={JSON.stringify(props.part.content ?? null)} />}
    </Collapsible>
  );
}

/** Sub-agent run, its text and steps shown when expanded */
export function Subagent(props: { part: SubagentPart }) {
  const blocks = createMemo(() => toBlocks(props.part.parts));
  const running = () => props.part.status === "running";
  const label = () => (humanize(props.part.name) || "Agent") + (props.part.status === "error" ? " · failed" : "");
  return (
    <Collapsible icon={<AgentIcon />} active={running()} timing={props.part} label={label()}>
      {() => (
        <div class="lc-content">
          <Show when={props.part.description}>
            <div class="lc-subagent-desc">{props.part.description}</div>
          </Show>
          <Blocks blocks={blocks()} active={running()} />
          {/* The result usually repeats the sub-agent final text, only shown when it streamed none */}
          <Show when={props.part.result !== undefined && !blocks().some((b) => b.kind === "text")}>
            <Code value={props.part.result!} />
          </Show>
          <Show when={props.part.error}>
            <div class="lc-error">{props.part.error}</div>
          </Show>
        </div>
      )}
    </Collapsible>
  );
}

type Step = ReasoningPart | ToolPart | StepPart | SubagentPart | ActivityPart;

/** Assistant content block: markdown text, consecutive steps (thinking, tool calls, sub-agents...) or a tool UI */
export type Block =
  | { kind: "text"; part: TextPart }
  | { kind: "steps"; steps: Step[] }
  | { kind: "widget"; part: ActivityPart };

/** Group parts in blocks. Whitespace-only text is skipped, so it neither adds a gap nor splits a group */
export function toBlocks(parts: Part[]): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text.trim()) out.push({ kind: "text", part: p });
    } else if (p.type === "activity" && p.activityType === WIDGET_ACTIVITY) {
      // Tool results without UI are not shown
      if (hasUi(p.content)) out.push({ kind: "widget", part: p });
    } else if (p.type !== "file") {
      const last = out[out.length - 1];
      if (last?.kind === "steps") last.steps.push(p);
      else out.push({ kind: "steps", steps: [p] });
    }
  }
  return out;
}

/** Content of an assistant message or sub-agent, the last block is active while it runs */
export function Blocks(props: { blocks: Block[]; active: boolean }) {
  return (
    // Index keeps components mounted by position, blocks are recomputed but only appended
    <Index each={props.blocks}>
      {(block, i) => (
        <Switch>
          <Match when={block().kind === "steps"}>
            <Steps
              steps={(block() as Extract<Block, { kind: "steps" }>).steps}
              active={props.active && i === props.blocks.length - 1}
            />
          </Match>
          <Match when={block().kind === "widget"}>
            <Widget part={(block() as Extract<Block, { kind: "widget" }>).part} />
          </Match>
          <Match when={block().kind === "text"}>
            <Markdown text={(block() as Extract<Block, { kind: "text" }>).part.text} />
          </Match>
        </Switch>
      )}
    </Index>
  );
}

function StepView(props: { part: Step; active: boolean }) {
  switch (props.part.type) {
    case "tool":
      return <ToolCall part={props.part} />;
    case "step":
      return <StepRow part={props.part} />;
    case "subagent":
      return <Subagent part={props.part} />;
    case "activity":
      return <Activity part={props.part} />;
    default:
      return <Reasoning part={props.part} active={props.active} />;
  }
}

/** Label of a step shown on its group line while running */
function runningLabel(step: Step) {
  switch (step.type) {
    case "tool":
      return humanize(step.name) || "Tool";
    case "step":
      return humanize(step.name) || "Step";
    case "subagent":
      return humanize(step.name) || "Agent";
    case "activity":
      return activityLabel(step);
    default:
      return "Thinking";
  }
}

/** Icon of a group: the first step that is not thinking */
function groupIcon(steps: Step[]) {
  switch (steps.find((s) => s.type !== "reasoning")?.type) {
    case "tool":
      return <ToolIcon />;
    case "step":
      return <StepIcon />;
    case "subagent":
      return <AgentIcon />;
    case "activity":
      return <ActivityIcon />;
    default:
      return <BulbIcon />;
  }
}

/** Label shown on a collapsed group once done, e.g. "Thought process · 2 tool calls" */
function summary(steps: Step[]) {
  const count = (type: Step["type"], label: string) => {
    const n = steps.filter((s) => s.type === type).length;
    return n ? `${n} ${label}${n > 1 ? "s" : ""}` : "";
  };
  return [
    steps.some((s) => s.type === "reasoning") ? "Thought process" : "",
    count("tool", "tool call"),
    count("subagent", "sub-agent"),
    count("step", "step"),
    count("activity", "update"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Consecutive steps. A single step is shown as is, several are grouped in one line
 * showing the running step (or a summary when done), expanding to the list of steps.
 */
export function Steps(props: { steps: Step[]; active: boolean }) {
  // Whole group duration: first step start to latest step end, running while active
  const timing = (): Timing => {
    const timed = props.steps.filter((s): s is Exclude<Step, ActivityPart> => s.type !== "activity");
    return {
      startedAt: timed[0]?.startedAt,
      endedAt: props.active ? undefined : Math.max(...timed.map((s) => s.endedAt ?? s.startedAt ?? 0)),
    };
  };
  return (
    <Show when={props.steps.length > 1} fallback={<StepView part={props.steps[0]} active={props.active} />}>
      <Collapsible
        icon={groupIcon(props.steps)}
        active={props.active}
        timing={timing()}
        label={props.active ? runningLabel(props.steps[props.steps.length - 1]) : summary(props.steps)}
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
