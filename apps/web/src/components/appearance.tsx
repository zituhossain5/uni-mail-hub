'use client';

import { createContext, useContext, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Check, Mail, Sparkles } from 'lucide-react';
import { appearanceKey, defaultAppearance, parseAppearance, themes, type Appearance, type Motion, type Theme } from '@/lib/appearance';
import { Dialog } from './dialog';

const changeEvent = 'umh-appearance-change';
const defaultSnapshot = JSON.stringify(defaultAppearance);
let memorySnapshot = defaultSnapshot;
let storageUnavailable = false;
function subscribe(callback: () => void) {
  const listener = () => {
    const current = parseAppearance(snapshot());
    document.documentElement.dataset.theme = current.theme;
    document.documentElement.dataset.motion = current.motion;
    callback();
  };
  window.addEventListener(changeEvent, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(changeEvent, listener); window.removeEventListener('storage', listener); };
}
function snapshot() {
  if (storageUnavailable) return memorySnapshot;
  try { return localStorage.getItem(appearanceKey) ?? memorySnapshot; } catch { return memorySnapshot; }
}

const AppearanceContext = createContext<{ preferences: Appearance; update: (value: Partial<Appearance>) => void }>({ preferences: defaultAppearance, update: () => {} });

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const raw = useSyncExternalStore(subscribe, snapshot, () => defaultSnapshot);
  const preferences = parseAppearance(raw);
  function update(value: Partial<Appearance>) {
    const next = { ...parseAppearance(snapshot()), ...value };
    memorySnapshot = JSON.stringify(next);
    try { localStorage.setItem(appearanceKey, memorySnapshot); } catch { storageUnavailable = true; }
    document.documentElement.dataset.theme = next.theme;
    document.documentElement.dataset.motion = next.motion;
    window.dispatchEvent(new Event(changeEvent));
  }
  return <AppearanceContext.Provider value={{ preferences, update }}>{children}</AppearanceContext.Provider>;
}

function ThemeSwatches({ compact = false }: { compact?: boolean }) {
  const { preferences, update } = useContext(AppearanceContext);
  return <div className={`theme-swatches ${compact ? 'theme-swatches-compact' : ''}`} role="group" aria-label="Dashboard color">
    {themes.map(theme => <button key={theme.id} type="button" className={`theme-swatch theme-swatch-${theme.id}`} style={{ '--swatch': theme.swatch } as CSSProperties} aria-label={`${theme.name} color theme`} aria-pressed={preferences.theme === theme.id} title={theme.name} onClick={() => update({ theme: theme.id as Theme })}>
      <span className="theme-swatch-color">{preferences.theme === theme.id && <Check size={14} strokeWidth={2.8} aria-hidden="true"/>}</span>
      {!compact && <span>{theme.name}</span>}
    </button>)}
  </div>;
}

const motionOptions: { value: Motion; title: string; description: string }[] = [
  { value: 'full', title: 'Full motion', description: 'Entrance animations, hover effects, soft background drift and live status pulses.' },
  { value: 'subtle', title: 'Subtle motion', description: 'Entrance animations and hover effects. Continuous animations are paused.' },
  { value: 'off', title: 'Motion off', description: 'A still workspace with all decorative animation and transitions turned off.' },
];

export function AppearanceControls() {
  const { preferences, update } = useContext(AppearanceContext);
  const [open, setOpen] = useState(false);
  return <>
    <div className="appearance-controls"><ThemeSwatches compact/><button type="button" className="icon-button motion-settings-button" aria-label="Appearance and motion settings" title="Appearance & motion" onClick={() => setOpen(true)}><Sparkles size={18} aria-hidden="true"/></button></div>
    <Dialog open={open} title="Make it yours" description="A little color. Just the right amount of motion. Your preferences are saved on this browser." onClose={() => setOpen(false)}>
      <div className="appearance-settings">
        <fieldset><legend>Workspace color</legend><ThemeSwatches/></fieldset>
        <div className="motion-preview" aria-hidden="true"><span className="motion-preview-orbit"/><span className="motion-preview-mail"><Mail size={29}/></span><span className="motion-preview-copy"><strong>Your workspace, in motion</strong><span><i className="ambient-status-dot"/> Live preview</span></span><span className="motion-preview-particle particle-one"/><span className="motion-preview-particle particle-two"/></div>
        <fieldset><legend>Animation</legend><div className="motion-options">{motionOptions.map(option => <label className={`motion-option ${preferences.motion === option.value ? 'selected' : ''}`} key={option.value}><input type="radio" name="workspace-motion" value={option.value} checked={preferences.motion === option.value} onChange={() => update({ motion: option.value })}/><span><strong>{option.title}</strong><small>{option.description}</small></span></label>)}</div></fieldset>
        <p className="motion-system-note">Your device’s reduced-motion preference is always respected. Animations are decorative; numbers change only when workspace data refreshes.</p>
      </div>
    </Dialog>
  </>;
}
