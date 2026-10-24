// CSS of the widgets and CSS colors for the canvas and graph libraries

/** Tag of the CSS of a widget, a plain string, for the formatter and editors to treat it as CSS */
export const css = String.raw;

/** CSS color variable as `[r, g, b]` for the canvas and graph libraries, whatever color syntax the host sends */
export const cssRgb = (name: string) => {
  // A probe element resolves `var()` and `light-dark()`, a canvas converts the color to rgb
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
};
