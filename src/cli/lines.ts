/**
 * A line source that does not lose input while the app is busy.
 *
 * `readline.question()` only captures a line if a question is pending. Any line
 * that arrives while the previous one is still being handled — which, in this
 * app, means during a 30-second generation — is delivered to nobody and
 * silently dropped. That is invisible when you type one line at a time and
 * obvious the moment you paste three commands or pipe a script: the first runs
 * and the rest vanish.
 *
 * This attaches one permanent `line` listener and queues, so input that arrives
 * mid-work waits its turn instead of disappearing.
 */

import { stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';

export class LineReader {
  private readonly rl: Interface;
  private readonly queue: string[] = [];
  private waiting?: { resolve: (v: string | undefined) => void };
  private ended = false;

  constructor(rl: Interface) {
    this.rl = rl;
    rl.on('line', (line: string) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    const finish = (): void => {
      this.ended = true;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.resolve(undefined);
      }
    };
    rl.on('close', finish);
  }

  /** Next line, or undefined at end of input. Prints `prompt` first. */
  async next(prompt: string): Promise<string | undefined> {
    // A queued line was typed before the prompt appeared; echo the prompt with
    // it so the transcript still reads as a conversation rather than as output
    // with no visible cause.
    const queued = this.queue.shift();
    if (queued !== undefined) {
      stdout.write(`${prompt}${queued}\n`);
      return queued;
    }
    if (this.ended) return undefined;

    stdout.write(prompt);
    return new Promise<string | undefined>((resolve) => {
      this.waiting = { resolve };
    });
  }

  /**
   * Resolve a pending prompt with "end of input", as if Ctrl-D arrived.
   * Ctrl+C at the prompt uses this to leave through the normal cleanup path
   * (status bar detached, db closed) instead of dying mid-frame.
   */
  cancel(): void {
    if (!this.waiting) return;
    const w = this.waiting;
    this.waiting = undefined;
    w.resolve(undefined);
  }

  /** True when input is waiting — used to skip cosmetic redraws. */
  get pending(): number {
    return this.queue.length;
  }
}
