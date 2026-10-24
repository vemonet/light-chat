// HTML escaping and CSS colors, shared by the widgets
export const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** CSS color variable as `[r, g, b]` for the canvas and graph libraries, whatever color syntax the host sends */
export const cssRgb = (name) => {
  // A probe element resolves `var()` and `light-dark()`, a canvas converts the color to rgb
  const probe = document.createElement("i");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
};
