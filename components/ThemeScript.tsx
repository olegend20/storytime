import { DEFAULT_TEXT_SCALE_INDEX, PREFS_KEY, TEXT_SCALES } from '@/lib/client/storage'

/**
 * Applies the stored reading preferences to <html> BEFORE first paint.
 *
 * Without this, every reload flashes the light theme and the default text size for one frame.
 * In a dark bedroom that flash is the whole problem, so it is worth an inline script. It also
 * means reading mode is expressed as a DOM attribute rather than React state, so the CSS above
 * can hide chrome with no hydration mismatch.
 *
 * Reads only our own localStorage key and is wrapped in try/catch: a browser blocking site data
 * throws on access, and the page must still render.
 */
const script = `(function(){try{
var raw = localStorage.getItem(${JSON.stringify(PREFS_KEY)});
var p = raw ? JSON.parse(raw) : {};
var root = document.documentElement;
if (p && (p.theme === 'dark' || p.theme === 'light' || p.theme === 'night')) root.setAttribute('data-theme', p.theme);
if (p && p.readingMode === true) root.setAttribute('data-reading', 'on');
var scales = ${JSON.stringify(TEXT_SCALES)};
var i = p && typeof p.textScaleIndex === 'number' ? p.textScaleIndex : ${DEFAULT_TEXT_SCALE_INDEX};
if (i >= 0 && i < scales.length) root.style.setProperty('--text-scale', String(scales[i]));
}catch(e){}})();`

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />
}
