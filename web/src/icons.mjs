// One small icon set (24px, stroke style) used by every page. Markup is trusted, static and never built from user data.
const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>',
  meter: '<circle cx="12" cy="13" r="8"/><path d="M12 13l3.5-4"/><path d="M7.5 17.5h9"/><path d="M12 5v2"/>',
  bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="3"/><circle cx="12" cy="12" r="2.8"/><path d="M6.5 9.5v.01M17.5 14.5v.01"/>',
  pool: '<path d="M12 3c3.5 4.2 6 7 6 10.2A6 6 0 0 1 12 19a6 6 0 0 1-6-5.8C6 10 8.5 7.2 12 3z"/><path d="M9.5 13.5a2.7 2.7 0 0 0 2.5 2.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.2-3.6 4.2-5.5 8-5.5s6.8 1.9 8 5.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  chain: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="3" y="8" width="18" height="12" rx="3"/><circle cx="16.5" cy="14" r="1.2" fill="currentColor"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.4 2.8 7.7 7 9.5 4.2-1.8 7-5.1 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  out: '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.5v.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
}

export const icon = (name, size) =>
  `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${size ? ` width="${size}" height="${size}"` : ''}>${PATHS[name] || ''}</svg>`

/** Replace every <i data-icon="name"></i> placeholder with its SVG. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    const name = el.getAttribute('data-icon')
    if (!(name in PATHS)) continue
    el.insertAdjacentHTML('afterbegin', icon(name))
    el.removeAttribute('data-icon')
  }
}

export const BRAND_MARK = icon('bolt')
