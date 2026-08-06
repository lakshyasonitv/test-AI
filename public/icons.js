// ---------------------------------------------------------------------------
// Inline SVG icon set.
//
// Stroke-based on a 24x24 grid, drawn with `currentColor`, so every icon takes the
// colour of the text around it and stays sharp at any size. Embedded rather than
// loaded from a CDN: the rest of this app is offline-safe and a redesign shouldn't
// be the thing that introduces a network dependency.
//
// Replaces the emoji the UI used to use (✔ ✘ ⚠ ⏳ ⛔ 🔑 ▼ ✕), which rendered
// differently on every OS and could not inherit theme colours.
// ---------------------------------------------------------------------------

const ICON_PATHS = {
  // --- status ---
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  "alert-triangle":
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  "alert-circle":
    '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  "slash-circle":
    '<circle cx="12" cy="12" r="10"/><path d="M4.93 4.93 19.07 19.07"/>',
  "minus-circle": '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  loader:
    '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  circle: '<circle cx="12" cy="12" r="10"/>',

  // --- actions / chrome ---
  plus: '<path d="M12 5v14M5 12h14"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  "external-link":
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  play: '<path d="M6 3.5v17l14-8.5z"/>',
  refresh:
    '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',

  // --- domain ---
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  braces:
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
  "file-text":
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield:
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
};

/**
 * Render an icon as an inline SVG string.
 * `aria-hidden` by default — icons here always sit next to a text label or inside a
 * control that carries its own aria-label, so announcing them twice is noise.
 */
function icon(name, { size = 16, cls = "", title = "" } = {}) {
  const paths = ICON_PATHS[name];
  if (!paths) return "";
  const a11y = title
    ? `role="img" aria-label="${title}"`
    : 'aria-hidden="true" focusable="false"';
  return (
    `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
    `stroke-linejoin="round" ${a11y}>${paths}</svg>`
  );
}

/** Status → icon name. One place, so the timeline, cards and history can't drift apart. */
const STATUS_ICON = {
  passed: "check",
  failed: "x",
  blocked: "slash-circle",
  truncated: "alert-triangle",
  truncated_no_assertion: "minus-circle",
  incomplete: "minus-circle",
  error: "alert-circle",
  pending: "clock",
  running: "loader",
};
