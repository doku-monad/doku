/**
 * Structured logging.
 *
 * One line per event, JSON in a deployment and human-readable on a terminal. The service ran on
 * `console.log` with the message half-formatted into a string, which is fine to read over your
 * shoulder and unusable for anything else: no levels, so an outage cannot be filtered from a
 * heartbeat; no fields, so "which market" cannot be searched; no consistent shape, so nothing can
 * count occurrences.
 *
 * Deliberately small. A logging library is a dependency, a configuration surface and a transport,
 * and this needs none of those — it needs levels, fields, and a shape a log aggregator can parse.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that stamps every line with these fields. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** JSON when false. Defaults to whether stdout is a terminal. */
  pretty?: boolean;
  /** Injected in tests. */
  write?: (line: string) => void;
  now?: () => Date;
}

/**
 * An `Error` cannot be serialised by `JSON.stringify` — it comes out as `{}`, which is how a
 * stack trace goes missing from a log that appears to be recording it. Same for `bigint`, which
 * throws outright, and this service is full of them.
 */
function encode(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  }
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS[options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? 20;
  const pretty = options.pretty ?? process.stdout.isTTY === true;
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const now = options.now ?? (() => new Date());

  const build = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVELS[level] < threshold) return;
      const merged = { ...bound, ...fields };
      if (pretty) {
        const rest = Object.entries(merged)
          .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(encode(v)) : String(v)}`)
          .join(" ");
        write(`${level.toUpperCase().padEnd(5)} ${message}${rest ? " " + rest : ""}`);
        return;
      }
      write(
        JSON.stringify({
          level,
          time: now().toISOString(),
          message,
          ...(encode(merged) as LogFields),
        }),
      );
    };

    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (fields) => build({ ...bound, ...fields }),
    };
  };

  return build({});
}

/** A logger that discards everything, for tests that are not asserting on output. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
