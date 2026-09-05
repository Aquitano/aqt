import { cancel, isCancel, log, spinner } from "@clack/prompts";

export function unwrap<T>(value: T | symbol): T {
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

export function die(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  log.error(`Bootstrapping failed: ${msg}`);
  process.exit(1);
}
