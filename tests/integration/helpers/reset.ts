import { DatabaseSync } from 'node:sqlite';
import { harness } from './harness.ts';

// Keeps the seeded 'home' kitchen because data tables reference it.
// Open a fresh handle per call — the server holds its own connection to the
// same file, and SQLite (in WAL mode) handles concurrent processes.
export async function resetDb(): Promise<void> {
  const db = new DatabaseSync(harness().dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
      DELETE FROM menu_recipes;
      DELETE FROM recipe_cookware;
      DELETE FROM recipe_ingredients;
      DELETE FROM menus;
      DELETE FROM recipes;
      DELETE FROM cookware;
      DELETE FROM ingredients;
      DELETE FROM kitchens WHERE slug != 'home';
    `);
  } finally {
    db.close();
  }
}
