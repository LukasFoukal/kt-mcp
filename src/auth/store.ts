/**
 * A tiny synchronous JSON file store.
 *
 * Holds OAuth clients and issued tokens so a redeploy doesn't force you to
 * reconnect the connector in Claude. Single-process and single-user, so the
 * whole document is read into memory and rewritten atomically on change.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonStore<T extends object> {
  private cache: T;

  constructor(
    private readonly file: string,
    fallback: T,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.cache = this.load(fallback);
  }

  private load(fallback: T): T {
    if (!existsSync(this.file)) return structuredClone(fallback);
    try {
      return { ...structuredClone(fallback), ...JSON.parse(readFileSync(this.file, 'utf8')) };
    } catch (error) {
      // A corrupt state file must not take the server down: the worst case is
      // re-authorizing the connector, which is a two-click recovery.
      console.error(`[store] ${this.file} is unreadable, starting fresh:`, error);
      return structuredClone(fallback);
    }
  }

  read(): Readonly<T> {
    return this.cache;
  }

  update(mutate: (state: T) => void): void {
    mutate(this.cache);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
