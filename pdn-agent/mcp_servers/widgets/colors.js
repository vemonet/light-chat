// HTML escaping, shared by the widgets
/* eslint-disable no-unused-vars -- globals used by the widget pages */
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
