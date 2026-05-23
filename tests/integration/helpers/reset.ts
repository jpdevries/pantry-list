import { Client } from 'pg';
import { harness } from './harness.ts';

// Keeps the seeded 'home' kitchen because data tables reference it.
export async function resetDb(): Promise<void> {
  const client = new Client({ connectionString: harness().dbUrl });
  await client.connect();
  try {
    await client.query(`
      TRUNCATE TABLE
        menu_recipes,
        recipe_cookware,
        recipe_ingredients,
        menus,
        recipes,
        cookware,
        ingredients
      RESTART IDENTITY CASCADE
    `);
    await client.query(`DELETE FROM kitchens WHERE slug != 'home'`);
  } finally {
    await client.end();
  }
}
