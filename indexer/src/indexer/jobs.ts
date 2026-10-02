export interface Job {
  stop(): void;
  runNow(): Promise<void>;
}

/**
 * A fixed-interval job that never overlaps itself and never dies.
 *
 * Overlap is the failure that matters for a rollup: two rebuilds racing on the same rows produce
 * deadlocks the retry helper then dutifully retries. A tick that finds the previous run still going
 * is skipped, not queued. Errors go to the caller and the next tick still fires — a stats job
 * that stopped after one bad tick would leave numbers ageing silently, which is this service's
 * signature failure.
 */
export function startJob(opts: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onError?: (error: unknown) => void;
  /** Run once immediately as well. Default true. */
  immediate?: boolean;
}): Job {
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await opts.run();
    } catch (e) {
      opts.onError?.(e);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();
  if (opts.immediate !== false) void tick();
  return { stop: () => clearInterval(timer), runNow: tick };
}
