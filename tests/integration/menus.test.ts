import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const CREATE_RECIPE = `
  mutation CR($title: String!) {
    createRecipe(title: $title, instructions: "x", ingredients: []) {
      id title
    }
  }
`;
const CREATE_MENU = `
  mutation CM($title: String!, $recipes: [MenuRecipeInput!]!) {
    createMenu(title: $title, recipes: $recipes) {
      id title slug active
      recipes { course recipe { title } }
    }
  }
`;
const TOGGLE = `
  mutation T($menuId: String!, $recipeId: String!, $course: String) {
    toggleRecipeInMenu(menuId: $menuId, recipeId: $recipeId, course: $course) {
      id
      recipes { recipe { title } }
    }
  }
`;
const UPDATE = `
  mutation U($id: String!, $title: String) {
    updateMenu(id: $id, title: $title) { id title }
  }
`;
const DELETE = `mutation D($id: String!) { deleteMenu(id: $id) }`;
const LIST = `query { menus { id title } }`;

describe('menus + recipe linking', () => {
  beforeEach(() => resetDb());

  it('creates a menu with two recipes, then toggles a third in', async () => {
    const r1 = await gql<{ createRecipe: { id: string } }>(CREATE_RECIPE, {
      title: 'Starter Soup',
    });
    const r2 = await gql<{ createRecipe: { id: string } }>(CREATE_RECIPE, {
      title: 'Main Roast',
    });
    const r3 = await gql<{ createRecipe: { id: string } }>(CREATE_RECIPE, {
      title: 'Dessert Tart',
    });

    const { createMenu } = await gql<{
      createMenu: { id: string; recipes: { recipe: { title: string } }[] };
    }>(CREATE_MENU, {
      title: 'Sunday Dinner',
      recipes: [
        { recipeId: r1.createRecipe.id, course: 'starter' },
        { recipeId: r2.createRecipe.id, course: 'main' },
      ],
    });
    assert.deepEqual(createMenu.recipes.map((r) => r.recipe.title).sort(), [
      'Main Roast',
      'Starter Soup',
    ]);

    const { toggleRecipeInMenu } = await gql<{
      toggleRecipeInMenu: { recipes: { recipe: { title: string } }[] };
    }>(TOGGLE, {
      menuId: createMenu.id,
      recipeId: r3.createRecipe.id,
      course: 'dessert',
    });
    assert.deepEqual(
      toggleRecipeInMenu.recipes.map((r) => r.recipe.title).sort(),
      ['Dessert Tart', 'Main Roast', 'Starter Soup'],
    );
  });

  it('toggle removes a recipe when it is already in the menu', async () => {
    const r1 = await gql<{ createRecipe: { id: string } }>(CREATE_RECIPE, {
      title: 'Toggleable',
    });
    const { createMenu } = await gql<{ createMenu: { id: string } }>(
      CREATE_MENU,
      {
        title: 'Toggle Menu',
        recipes: [{ recipeId: r1.createRecipe.id }],
      },
    );

    // First toggle: present → remove (length 0)
    const off = await gql<{
      toggleRecipeInMenu: { recipes: unknown[] };
    }>(TOGGLE, { menuId: createMenu.id, recipeId: r1.createRecipe.id });
    assert.equal(off.toggleRecipeInMenu.recipes.length, 0);

    // Second toggle: absent → add back (length 1)
    const on = await gql<{
      toggleRecipeInMenu: { recipes: { recipe: { title: string } }[] };
    }>(TOGGLE, { menuId: createMenu.id, recipeId: r1.createRecipe.id });
    assert.deepEqual(on.toggleRecipeInMenu.recipes.map((r) => r.recipe.title), [
      'Toggleable',
    ]);
  });

  it('updates and deletes a menu', async () => {
    const { createMenu } = await gql<{ createMenu: { id: string } }>(
      CREATE_MENU,
      { title: 'Draft', recipes: [] },
    );
    const { updateMenu } = await gql<{ updateMenu: { title: string } | null }>(
      UPDATE,
      { id: createMenu.id, title: 'Finalized' },
    );
    assert.equal(updateMenu?.title, 'Finalized');

    await gql(DELETE, { id: createMenu.id });
    const { menus } = await gql<{ menus: { title: string }[] }>(LIST);
    assert.ok(!menus.some((m) => m.title === 'Finalized'));
  });
});
