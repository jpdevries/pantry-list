import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { harness } from './harness.ts';

const RESET_SQL = `
PRAGMA busy_timeout = 5000;
DELETE FROM menu_recipes;
DELETE FROM recipe_cookware;
DELETE FROM recipe_ingredients;
DELETE FROM menus;
DELETE FROM recipes;
DELETE FROM cookware;
DELETE FROM ingredients;
DELETE FROM kitchens WHERE slug != 'home';
`;

// Keeps the seeded 'home' kitchen because data tables reference it. In native
// mode we open a fresh node:sqlite handle to the same file the server uses —
// WAL handles the concurrency. In docker mode we instead run `sqlite3` inside
// the container, because opening the bind-mounted DB from the host across
// Docker Desktop's VirtioFS/gRPC-FUSE layer doesn't share the WAL `-shm` file
// reliably and host-side writes can stall on locks held by the container.
export async function resetDb(): Promise<void> {
  const h = harness();

  if (h.containerId) {
    const r = spawnSync(
      'docker',
      ['exec', '-i', h.containerId, 'sqlite3', '/data/pantry.db'],
      { input: RESET_SQL, encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(
        `docker exec sqlite3 failed (${r.status}): ${r.stderr || r.stdout}`,
      );
    }
    return;
  }

  const db = new DatabaseSync(h.dbPath);
  try {
    db.exec(RESET_SQL);
  } finally {
    db.close();
  }
}
