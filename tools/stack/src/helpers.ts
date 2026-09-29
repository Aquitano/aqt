import { cancel, isCancel, log, spinner, type CANCEL_SYMBOL } from "@clack/prompts";

export function unwrap<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    cancel("Operation cancelled.");
    process.exit(0);
  }
  return value;
}

export async function step(
  label: string,
  fn: () => Promise<void>,
  { verbose = false } = {},
): Promise<void> {
  if (verbose) {
    log.info(`${label}…`);
    await fn();
    log.success(`${label} ✓`);
  } else {
    const s = spinner();
    s.start(`${label}…`);
    try {
      await fn();
      s.stop(`${label} ✓`);
    } catch (err) {
      s.stop(`${label} ✗`);
      throw err;
    }
  }
}

/** Report a rejected top-level promise. The cause is whatever was thrown, so it stays `unknown`. */
export function die(cause: unknown): never {
  const message = cause instanceof Error ? cause.message : String(cause);
  log.error(`Bootstrapping failed: ${message}`);
  process.exit(1);
}
