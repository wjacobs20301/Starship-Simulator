// Live objectives while flying, the results screen, and best scores. (Missions are picked in the
// main menu, gameMenu.ts.)

import { type MissionDef, type MissionId, type MissionResult, type ObjectiveState } from '../game/missions';

const BEST_KEY = 'starship-sim:best';
const ICON: Record<ObjectiveState, string> = { pending: '○', done: '✓', failed: '✗' };

export function loadBest(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function saveBest(best: Record<string, number>): void {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    // Storage unavailable (private window): best scores just aren't kept.
  }
}

export class MissionUi {
  private tracker: HTMLElement;
  private results: HTMLElement;
  private best = loadBest();
  private lastTracker = '';
  selected: MissionId = 'ift';

  constructor(
    parent: HTMLElement,
    private handlers: { select(id: MissionId): void; retry(): void; menu(): void },
  ) {
    this.tracker = el('div', 'objectives', 'hud hidden');
    this.results = el('div', 'results', 'hidden');
    parent.append(this.tracker, this.results);
    this.results.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.act;
      if (act === 'retry') handlers.retry();
      else if (act === 'menu') handlers.menu();
      else if (act === 'close') this.results.classList.add('hidden');
    });
  }

  select(id: MissionId): void {
    this.selected = id;
    this.handlers.select(id);
  }

  hideResults(): void {
    this.results.classList.add('hidden');
  }

  /** Live objective list while a mission is flying. */
  updateTracker(mission: MissionDef | null, states: ObjectiveState[], score: number): void {
    const show = !!mission && mission.objectives.length > 0;
    this.tracker.classList.toggle('hidden', !show);
    document.body.classList.toggle('mission-on', show);
    if (!show || !mission) return;
    const html =
      `<div class="ob-title">${mission.title.toUpperCase()}<span>${score}</span></div>` +
      mission.objectives.map((o, i) => `<div class="ob ${states[i]}"><i>${ICON[states[i]]}</i>${o.label}</div>`).join('');
    if (html !== this.lastTracker) {
      this.tracker.innerHTML = html;
      this.lastTracker = html;
    }
  }

  showResults(r: MissionResult): void {
    const prev = this.best[r.mission.id];
    const record = prev === undefined || r.total > prev;
    if (record) {
      this.best[r.mission.id] = r.total;
      saveBest(this.best);
    }
    const objectives = r.mission.objectives
      .map((o, i) => `<div class="ob ${r.states[i]}"><i>${ICON[r.states[i]]}</i>${o.label}</div>`)
      .join('');
    const lines = r.lines.map((l) => `<div class="rs-line"><span>${l.label}</span><b>${l.points}</b></div>`).join('');
    this.results.innerHTML =
      `<div class="rs-card">` +
      `<div class="rs-title">${r.mission.title.toUpperCase()} · ${r.states.every((s) => s === 'done') ? 'MISSION COMPLETE' : 'MISSION OVER'}</div>` +
      `<div class="rs-grade g-${r.grade}">${r.grade}</div>` +
      `<div class="rs-total">${r.total}<span> / 1000</span>${record ? '<em>new best</em>' : `<em>best ${prev}</em>`}</div>` +
      `<div class="rs-obj">${objectives}</div><div class="rs-lines">${lines}</div>` +
      `<div class="rs-buttons"><button data-act="retry">Retry</button><button data-act="menu">Main menu</button><button data-act="close">Keep watching</button></div>` +
      `</div>`;
    this.results.classList.remove('hidden');
  }
}

function el(tag: string, id: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.id = id;
  e.className = cls;
  return e;
}
