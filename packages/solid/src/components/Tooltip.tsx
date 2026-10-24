import { children, createEffect, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

type Side = "top" | "bottom" | "left" | "right";

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };
// Hover time before showing, skipped while moving from one tooltip to the next
const DELAY = 400;
const WARM = 400;
// Space between trigger and tooltip, and kept from the viewport edges
const GAP = 6;
const MARGIN = 8;
let lastHidden = 0;

/** Key names as shown, Mod is Cmd on Apple devices and Ctrl elsewhere */
export const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const KEYS: Record<string, [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  ctrl: ["⌃", "Ctrl"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
  enter: ["↵", "Enter"],
  escape: ["Esc", "Esc"],
};
const keyLabel = (key: string) => KEYS[key.toLowerCase()]?.[mac ? 0 : 1] ?? key.toUpperCase();

/** Place the tooltip on `side` of the anchor, on the other side when it does not fit, kept inside the viewport */
function place(tip: HTMLElement, anchor: HTMLElement, side: Side) {
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const room = { top: a.top, bottom: innerHeight - a.bottom, left: a.left, right: innerWidth - a.right };
  const size = side === "top" || side === "bottom" ? t.height : t.width;
  if (room[side] < size + GAP + MARGIN && room[OPPOSITE[side]] > room[side]) side = OPPOSITE[side];
  const x =
    side === "left" ? a.left - GAP - t.width : side === "right" ? a.right + GAP : a.left + (a.width - t.width) / 2;
  const y =
    side === "top" ? a.top - GAP - t.height : side === "bottom" ? a.bottom + GAP : a.top + (a.height - t.height) / 2;
  tip.style.left = `${Math.max(MARGIN, Math.min(x, innerWidth - t.width - MARGIN))}px`;
  tip.style.top = `${Math.max(MARGIN, Math.min(y, innerHeight - t.height - MARGIN))}px`;
}

function Bubble(props: { anchor: HTMLElement; side: Side; label: JSX.Element; shortcut?: string }) {
  let tip!: HTMLDivElement;
  // Top layer popover: above full screen widgets and not clipped by scrolling or hidden overflow
  onMount(() => {
    tip.showPopover();
    place(tip, props.anchor, props.side);
  });
  return (
    <div ref={tip} class="lc-tooltip" role="tooltip" popover="manual">
      <span>{props.label}</span>
      <Show when={props.shortcut}>
        {(keys) => (
          <kbd class="lc-shortcut">
            {keys()
              .split("+")
              .map((key) => (
                <kbd>{keyLabel(key)}</kbd>
              ))}
          </kbd>
        )}
      </Show>
    </div>
  );
}

/** Tooltip shown when hovering or keyboard focusing its child element, with the keyboard shortcut doing the same */
export function Tooltip(props: {
  label: JSX.Element;
  /** Keys joined with "+", e.g. "Mod+Shift+O", Mod is Cmd on Apple devices and Ctrl elsewhere */
  shortcut?: string;
  /** Preferred side, default bottom */
  side?: Side;
  /** Only shown when the child's text is cut, e.g. by an ellipsis */
  truncated?: boolean;
  disabled?: boolean;
  children: JSX.Element;
}) {
  const resolved = children(() => props.children);
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    clearTimeout(timer);
    if (anchor()) lastHidden = Date.now();
    setAnchor(undefined);
  };

  // Show after a delay on mouse hover or keyboard focus, hide on leave, click or blur
  createEffect(() => {
    const el = resolved.toArray().find((node): node is HTMLElement => node instanceof HTMLElement);
    if (!el) return;
    const show = () => {
      if (props.disabled || (props.truncated && el.scrollWidth <= el.clientWidth)) return;
      clearTimeout(timer);
      timer = setTimeout(() => setAnchor(el), Date.now() - lastHidden < WARM ? 0 : DELAY);
    };
    const onEnter = (e: PointerEvent) => e.pointerType !== "touch" && show();
    const onFocus = () => el.matches(":focus-visible") && show();
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", hide);
    el.addEventListener("pointerdown", hide);
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", hide);
    onCleanup(() => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", hide);
      el.removeEventListener("pointerdown", hide);
      el.removeEventListener("focus", onFocus);
      el.removeEventListener("blur", hide);
      hide();
    });
  });

  // While shown: hidden on Escape, and on scroll since it would no longer be next to its trigger
  createEffect(() => {
    if (!anchor()) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    });
  });
  createEffect(() => props.disabled && hide());

  return (
    <>
      {resolved()}
      <Show when={anchor()}>
        {(el) => (
          // In the chat root to get its theme variables
          <Portal mount={el().closest(".lc-root") ?? document.body}>
            <Bubble anchor={el()} side={props.side ?? "bottom"} label={props.label} shortcut={props.shortcut} />
          </Portal>
        )}
      </Show>
    </>
  );
}
