import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerEvent } from '@openscreeps/game';
import type { ServerConfig } from '../contracts.ts';

/** Original launcher's per-component files and rotation, without owning another process supervisor. */
export class WorkerLogs implements Disposable {
  readonly #files = new Map<string, number>();

  constructor(readonly config: ServerConfig) {
    if (config.logDirectory) mkdirSync(config.logDirectory, { recursive: true });
  }

  readonly event = (event: WorkerEvent): void => {
    const { logDirectory, logConsole } = this.config;
    if (event.type === 'started' && logDirectory) {
      const previous = this.#files.get(event.name);
      if (previous !== undefined) closeSync(previous);
      this.#files.delete(event.name);
      const filename = join(logDirectory, `${event.name}.log`);
      const keep = this.config.logRotateKeep ?? 5;
      if (keep > 0) {
        for (let index = keep; index > 1; index--) {
          const source = `${filename}.${String(index - 1)}`;
          const destination = `${filename}.${String(index)}`;
          if (!existsSync(source)) continue;
          rmSync(destination, { force: true });
          renameSync(source, destination);
        }
        if (existsSync(filename)) {
          rmSync(`${filename}.1`, { force: true });
          renameSync(filename, `${filename}.1`);
        }
      }
      this.#files.set(event.name, openSync(filename, 'w', 0o600));
    }
    if (event.type === 'output') {
      const file = this.#files.get(event.name);
      if (file !== undefined) writeSync(file, event.text);
      if (logConsole || !logDirectory) {
        const stream = event.stream === 'stderr' ? process.stderr : process.stdout;
        stream.write(`[${event.name}] ${event.text}`);
      }
    } else if (logConsole) {
      process.stdout.write(
        `[${event.name}] ${event.type}${event.pid === undefined ? '' : ` pid=${String(event.pid)}`}\n`,
      );
    }
  };

  [Symbol.dispose](): void {
    for (const file of this.#files.values()) closeSync(file);
    this.#files.clear();
  }
}
