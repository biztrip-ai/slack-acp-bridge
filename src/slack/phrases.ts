/** Random "I'm working on it" placeholders — one is picked per turn. */
export const THINKING_PHRASES: readonly string[] = [
  "cogitatating...",
  "ruminapping...",
  "ponderizing...",
  "syllogisifying...",
  "deliberatening...",
  "hypothesnoozing...",
  "percologitating...",
  "conflabulating...",
  "noodlebrating...",
  "mullingate...",
  "brainstorbling...",
  "contemplifying...",
  "inferenciating...",
  "metacognizzling...",
  "epiphanizing...",
  "deducticating...",
  "cerebrolating...",
  "reckonifying...",
  "surmisening...",
];

export function randomPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]!;
}
