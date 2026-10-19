export const THEMES = ['system', 'light', 'dark'];
export function resolveTheme(preference, systemDark) { return preference === 'dark' || (preference !== 'light' && systemDark) ? 'dark' : 'light'; }
export function createTheme({ root = document.documentElement, storage = localStorage, media = matchMedia('(prefers-color-scheme: dark)') } = {}) {
  let preference = 'system';
  try { const saved = storage.getItem('mirea.theme'); if (THEMES.includes(saved)) preference = saved; } catch {}
  const render = () => { root.dataset.theme = resolveTheme(preference, media.matches); root.style.colorScheme = root.dataset.theme; };
  media.addEventListener?.('change', render); render();
  return { get value() { return preference; }, set(value) { if (!THEMES.includes(value)) throw new Error('Unknown theme'); preference = value; try { storage.setItem('mirea.theme', value); } catch {} render(); }, dispose() { media.removeEventListener?.('change', render); } };
}
