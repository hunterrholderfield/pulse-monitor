'use strict';
/* Theme + background boot for Pulse.
 * Loaded as the FIRST script inside <body> so the saved [data-theme] /
 * [data-background] attributes are set before first paint (no flash).
 * Must stay an external file: the CSP only allows 'self' scripts. */
(() => {

const THEMES = [
  // sw.* are fixed preview colors for the picker swatches — they depict the
  // theme itself, so they intentionally do not adapt to the active theme.
  { id: 'cyan',     name: 'PULSE',    sw: { surface: '#060a12', accents: ['#38d5f5', '#f07dfc', '#2fe3a7'] } },
  { id: 'ember',    name: 'EMBER',    sw: { surface: '#0f0704', accents: ['#ff9d45', '#ff7d9c', '#ffe066'] } },
  { id: 'matrix',   name: 'MATRIX',   sw: { surface: '#020805', accents: ['#4ade80', '#2dd4bf', '#a3e635'] } },
  { id: 'violet',   name: 'VIOLET',   sw: { surface: '#0a0614', accents: ['#a78bfa', '#f472b6', '#7dd3fc'] } },
  { id: 'light',    name: 'LIGHT',    sw: { surface: '#e9eef5', accents: ['#0e7490', '#a21caf', '#047857'] } },
  { id: 'contrast', name: 'CONTRAST', sw: { surface: '#000000', accents: ['#00e5ff', '#ff4dff', '#00ff88'] } },
];
const BACKGROUNDS = [
  { id: 'grid',     name: 'GRID' },
  { id: 'dots',     name: 'DOTS' },
  { id: 'plain',    name: 'PLAIN' },
  { id: 'gradient', name: 'GRADIENT' },
];

const KEY_THEME = 'pulse.theme';
const KEY_BG = 'pulse.background';

const validTheme = (id) => (THEMES.some((t) => t.id === id) ? id : THEMES[0].id);
const validBg = (id) => (BACKGROUNDS.some((b) => b.id === id) ? id : BACKGROUNDS[0].id);

function announce() {
  window.dispatchEvent(new CustomEvent('pulse-theme-changed'));
}

function setTheme(id) {
  id = validTheme(id);
  document.body.dataset.theme = id;
  try { localStorage.setItem(KEY_THEME, id); } catch { /* storage may be unavailable */ }
  announce();
}

function setBackground(id) {
  id = validBg(id);
  document.body.dataset.background = id;
  try { localStorage.setItem(KEY_BG, id); } catch { /* storage may be unavailable */ }
  announce();
}

// apply persisted choices immediately — before any content is parsed/painted
let savedTheme = null, savedBg = null;
try {
  savedTheme = localStorage.getItem(KEY_THEME);
  savedBg = localStorage.getItem(KEY_BG);
} catch { /* storage may be unavailable */ }
document.body.dataset.theme = validTheme(savedTheme);
document.body.dataset.background = validBg(savedBg);

window.PulseTheme = {
  THEMES, BACKGROUNDS, setTheme, setBackground,
  get theme() { return document.body.dataset.theme; },
  get background() { return document.body.dataset.background; },
};

})();
