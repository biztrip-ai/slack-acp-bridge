/**
 * Minimal leveled logger (no deps). LOG_LEVEL=debug|info|warn|error.
 * Mirrors the Python bot's stderr logging: one line per event, namespaced.
 */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: string | undefined): void {
  const l = (level ?? "info").toLowerCase() as Level;
  threshold = ORDER[l] ?? ORDER.info;
}

export function isDebug(): boolean {
  return threshold <= ORDER.debug;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(name: string): Logger;
}

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function createLogger(name: string): Logger {
  const emit = (level: Level, msg: string, args: unknown[]) => {
    if (ORDER[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${name}: ${msg}${
      args.length ? " " + args.map(fmt).join(" ") : ""
    }`;
    process.stderr.write(line + "\n");
  };
  return {
    debug: (m, ...a) => emit("debug", m, a),
    info: (m, ...a) => emit("info", m, a),
    warn: (m, ...a) => emit("warn", m, a),
    error: (m, ...a) => emit("error", m, a),
    child: (sub) => createLogger(`${name}.${sub}`),
  };
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
