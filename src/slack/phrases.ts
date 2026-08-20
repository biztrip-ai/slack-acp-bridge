/** Random "I'm working on it" placeholders — one is picked per turn. */
export const THINKING_PHRASES: readonly string[] = [
  "thinking…", "pondering…", "consulting the oracle…", "crunching bits…",
  "warming up the neurons…", "reticulating splines…", "summoning the answer…",
  "bribing the LLM…", "rummaging through tabs…", "spinning up the hamster wheel…",
  "untangling my thoughts…", "checking my notes…", "negotiating with future me…",
  "warming up the GPUs…", "googling, but cooler…", "peeling back the layers…",
  "reading between the lines…", "sharpening pencils…", "putting the kettle on…",
  "waking up the interns…", "polishing my answer…",
  // Movie / TV references
  "compiling the Matrix…", "phoning home…", "consulting HAL 9000…", "checking with the Force…",
  "I'll be right back…", "going to plaid…", "channeling Yoda…", "consulting the precogs…",
  "to infinity and beyond…", "may the odds be in my favor…", "assembling the Avengers…",
  "warming up the DeLorean…", "winter is coming…", "asking Gandalf for advice…",
  "feeding the Mogwai (not after midnight)…", "checking in with the Dude…", "shaken, not stirred…",
  "warming up the TARDIS…", "doing the math like Will Hunting…", "pulling a Hermione…",
  "putting the band back together…", "calling Ghostbusters…",
  // Music / pop-culture references
  "queuing up Bohemian Rhapsody…", "channeling my inner Beyoncé…", "dropping the beat…", "remixing the answer…",
  // Gaming / nerd-culture references
  "rolling for initiative…", "punching in the Konami code…", "doing a barrel roll…",
  "shaking the Magic 8-Ball…", "respawning at the keyboard…",
];

export function randomPhrase(): string {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]!;
}
