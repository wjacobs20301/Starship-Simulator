// The keys as the player has them (settings.keys), for everything that names one: the help
// panel, the menus, the hints in the HUD. So a hint never names a key that has been changed.

import { settings } from '../settings';
import { type KeyAction, keyLabel, keysOf } from './keys';

/** What's on an action's key now ('—' if it has none). */
export function keyText(action: KeyAction): string {
  const k = keysOf(action, settings.keys)[0];
  return k === undefined ? '—' : keyLabel(k);
}

/** The same as a key cap, for HTML. */
export function kbd(action: KeyAction): string {
  return `<kbd>${escapeHtml(keyText(action))}</kbd>`;
}

/** Text with its {key:action} marks turned into key caps (the missions' briefs name keys so). */
export function withKeys(text: string): string {
  return text.replace(/\{key:(\w+)\}/g, (_, action: string) => kbd(action as KeyAction));
}

/** The same in plain text (the flight log's lines, a tooltip). */
export function withKeyNames(text: string): string {
  return text.replace(/\{key:(\w+)\}/g, (_, action: string) => keyText(action as KeyAction));
}

/** (A key's name can be any character the keyboard types: < and & among them.) */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Write the current keys into the key caps marked with their action (<kbd data-key="map">): the
 * help panel in index.html, and its copy on the menu's Controls page.
 */
export function paintKeys(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('kbd[data-key]').forEach((el) => {
    const text = keyText(el.dataset.key as KeyAction);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('unbound', text === '—');
  });
}
