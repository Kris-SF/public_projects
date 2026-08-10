/**
 * Snapshot persistence.
 *
 * Games are small and short-lived, so the whole set is kept in memory and
 * flushed to one JSON file on a short debounce. That is enough to survive a
 * restart or a redeploy mid-game, which is the only durability this needs.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const FLUSH_MS = 250;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;   // a table abandoned for half a day is done

export class Store {
  constructor(path) {
    this.path = path;
    this.games = new Map();
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const game of raw.games ?? []) {
        // Nobody is connected across a restart, whatever the snapshot claimed.
        for (const p of game.players) p.connected = false;
        this.games.set(game.code, game);
      }
      this.sweep();
      console.log(`[store] restored ${this.games.size} game(s) from ${this.path}`);
    } catch (err) {
      console.error(`[store] could not read ${this.path}, starting empty:`, err.message);
    }
  }

  flush() {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ games: [...this.games.values()] }));
      renameSync(tmp, this.path);   // atomic, so a crash mid-write cannot corrupt it
    } catch (err) {
      console.error('[store] flush failed:', err.message);
    }
  }

  /** Coalesce the writes a burst of player actions would otherwise cause. */
  touch() {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  get(code) {
    return this.games.get(code);
  }

  set(game) {
    this.games.set(game.code, game);
    this.touch();
    return game;
  }

  delete(code) {
    const gone = this.games.delete(code);
    if (gone) this.touch();
    return gone;
  }

  sweep(now = Date.now()) {
    let dropped = 0;
    for (const [code, game] of this.games) {
      if (now - (game.lastActivity ?? game.createdAt) > MAX_AGE_MS) {
        this.games.delete(code);
        dropped++;
      }
    }
    if (dropped) this.touch();
    return dropped;
  }
}
