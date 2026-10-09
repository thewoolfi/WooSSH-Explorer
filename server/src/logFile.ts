import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A size-rotated log file.
 *
 * The desktop application has no console: started from a shortcut, everything the
 * logger writes to stderr goes nowhere, so a user hitting a bug had nothing to send
 * and a diagnosis had to be reconstructed from a screenshot. This gives them a file,
 * a menu item to open it and something to attach to a report.
 *
 * Deliberately synchronous and best-effort: log lines are small and rare compared to
 * the traffic this process handles, and a logger that can throw — or that loses the
 * lines before a crash — is worse than a slow one.
 */
export interface FileSinkOptions {
  filePath: string;
  /** Rotate once the file passes this size. */
  maxBytes?: number;
  /** How many rotated files to keep (`app.log.1`, `app.log.2`, …). */
  keep?: number;
}

export class RotatingFileSink {
  private readonly maxBytes: number;
  private readonly keep: number;
  /** Bytes in the current file, tracked so a rotate decision costs no stat per line. */
  private size = 0;
  private broken = false;

  constructor(private readonly options: FileSinkOptions) {
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.keep = Math.max(1, options.keep ?? 3);
    try {
      mkdirSync(path.dirname(options.filePath), { recursive: true });
      this.size = statSync(options.filePath).size;
    } catch {
      this.size = 0;
    }
  }

  write(line: string): void {
    if (this.broken) return;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (this.size + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.options.filePath, line, 'utf8');
      this.size += bytes;
    } catch {
      // A read-only home directory must not take the application down with it.
      this.broken = true;
    }
  }

  private rotate(): void {
    // `app.log.1` is the newest archive; the oldest falls off the end.
    for (let index = this.keep; index >= 1; index -= 1) {
      const from = index === 1 ? this.options.filePath : `${this.options.filePath}.${index - 1}`;
      const to = `${this.options.filePath}.${index}`;
      try {
        if (index === this.keep) rmSync(to, { force: true });
        renameSync(from, to);
      } catch {
        /* the source may not exist yet */
      }
    }
    this.size = 0;
  }

  /** Where the file lives, for the "open logs" action. */
  get file(): string {
    return this.options.filePath;
  }

  get available(): boolean {
    return !this.broken;
  }
}
