export const appearanceKey = 'umh-appearance';
export const themes = [
  { id: 'harbor', name: 'Harbor', swatch: '#285664' },
  { id: 'lavender', name: 'Lavender', swatch: '#b5a4ee' },
  { id: 'mint', name: 'Mint', swatch: '#8bcfcb' },
  { id: 'cloud', name: 'Cloud', swatch: '#dce5f2' },
  { id: 'snow', name: 'Snow', swatch: '#f8fafc' },
] as const;
export type Theme = typeof themes[number]['id'];
export type Motion = 'full' | 'subtle' | 'off';
export type Appearance = { theme: Theme; motion: Motion };
export const defaultAppearance: Appearance = { theme: 'lavender', motion: 'full' };

export function parseAppearance(raw: string | null): Appearance {
  try {
    const value = JSON.parse(raw ?? '{}');
    return {
      theme: themes.some(theme => theme.id === value?.theme) ? value.theme : 'lavender',
      motion: ['full', 'subtle', 'off'].includes(value?.motion) ? value.motion : 'full',
    };
  } catch { return defaultAppearance; }
}

// Apply saved preferences before the first paint. Stored values are allowlisted.
export const appearanceBootstrap = `(function(){try{var p=JSON.parse(localStorage.getItem('${appearanceKey}')||'{}');if(['harbor','lavender','mint','cloud','snow'].indexOf(p.theme)>-1)document.documentElement.dataset.theme=p.theme;if(['full','subtle','off'].indexOf(p.motion)>-1)document.documentElement.dataset.motion=p.motion;}catch(e){}})();`;
