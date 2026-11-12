// What a logged event is, apart from its wording. The sim logs its events as text (for the log,
// the webcast's captions); the game also acts on some of them (the camera goes with the booster
// at separation, a catch has its sound, a mission hands over at SECO...). That is told from the
// event's kind, worked out here, in one place, from the wording, and pinned by
// tests/events.test.ts: a message reworded without its line here fails that test, instead of the
// game quietly no longer reacting to it.

export type EventKind =
  | 'liftoff'
  | 'separation'
  | 'seco'
  | 'boosterCaught'
  | 'shipCaught'
  | 'grab'
  | 'stacked'
  | 'touchdown'
  | 'splashdown'
  | 'finalApproach'
  | 'landingFlip'
  | 'doorOpening'
  | 'doorClosed';

/** Which vehicle an event is about, where its wording says. */
export type EventWho = 'booster' | 'ship';

const KINDS: [RegExp, EventKind][] = [
  [/^Liftoff/, 'liftoff'],
  [/^Stage separation/, 'separation'],
  [/^SECO/, 'seco'],
  [/^Booster caught!/, 'boosterCaught'],
  [/^Ship caught by the Pad \d tower!/, 'shipCaught'],
  [/chopsticks lifting/, 'grab'],
  [/^Starship stacked on Super Heavy/, 'stacked'],
  [/^Return: flip and landing burn/, 'landingFlip'],
  [/^Final approach/, 'finalApproach'],
  [/^Payload door opening/, 'doorOpening'],
  [/^Payload door closed/, 'doorClosed'],
  // (After the catches and the stacking, whose wording has neither word.)
  [/\btouchdown\b/, 'touchdown'],
  [/\bsplashdown\b/, 'splashdown'],
];

export function eventKind(text: string): EventKind | undefined {
  for (const [re, kind] of KINDS) if (re.test(text)) return kind;
  return undefined;
}

export function eventWho(text: string): EventWho | undefined {
  if (/^Super Heavy|^Booster/.test(text)) return 'booster';
  if (/^Starship|^Ship/.test(text)) return 'ship';
  return undefined;
}
