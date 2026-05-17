import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const CREATE = `
  mutation Create(
    $title: String!,
    $instructions: String!,
    $ingredients: [RecipeIngredientInput!]!,
    $tags: [String!],
  ) {
    createRecipe(
      title: $title,
      instructions: $instructions,
      ingredients: $ingredients,
      tags: $tags,
    ) {
      id slug title tags
      ingredients { ingredientName quantity unit }
    }
  }
`;

const FETCH = `
  query Fetch($id: String!) {
    recipe(id: $id) {
      id slug title tags
      ingredients { ingredientName }
    }
  }
`;

const UPDATE = `
  mutation Update(
    $id: String!,
    $title: String,
    $ingredients: [RecipeIngredientInput!],
  ) {
    updateRecipe(id: $id, title: $title, ingredients: $ingredients) {
      id title
      ingredients { ingredientName }
    }
  }
`;

const DELETE = `mutation Del($id: String!) { deleteRecipe(id: $id) }`;
const LIST = `
  query List($title: String, $tags: [String!]) {
    recipes(title: $title, tags: $tags) { id title }
  }
`;

describe('recipes CRUD', () => {
  beforeEach(() => resetDb());

  it('creates a recipe with nested ingredients and slugifies the title', async () => {
    const { createRecipe } = await gql<{
      createRecipe: {
        id: string;
        slug: string;
        ingredients: { ingredientName: string; quantity: number | null }[];
      };
    }>(CREATE, {
      title: 'Tomato Basil Pasta!',
      instructions: '1. Boil water\n2. Cook pasta',
      ingredients: [
        { ingredientName: 'Pasta', quantity: 200, unit: 'g' },
        { ingredientName: 'Tomato', quantity: 3 },
      ],
      tags: ['italian'],
    });
    assert.equal(createRecipe.slug, 'tomato-basil-pasta');
    assert.equal(createRecipe.ingredients.length, 2);
  });

  it('fetches a recipe by slug', async () => {
    await gql(CREATE, {
      title: 'Greek Salad',
      instructions: 'Toss',
      ingredients: [{ ingredientName: 'Feta' }],
    });
    const { recipe } = await gql<{
      recipe: { title: string; ingredients: { ingredientName: string }[] };
    }>(FETCH, { id: 'greek-salad' });
    assert.equal(recipe.title, 'Greek Salad');
    assert.equal(recipe.ingredients[0].ingredientName, 'Feta');
  });

  it('updates the title and replaces the ingredient list', async () => {
    const created = await gql<{ createRecipe: { id: string } }>(CREATE, {
      title: 'Pancakes',
      instructions: 'Mix',
      ingredients: [
        { ingredientName: 'Flour' },
        { ingredientName: 'Eggs' },
      ],
    });
    const updated = await gql<{
      updateRecipe: {
        title: string;
        ingredients: { ingredientName: string }[];
      };
    }>(UPDATE, {
      id: created.createRecipe.id,
      title: 'Buttermilk Pancakes',
      ingredients: [
        { ingredientName: 'Flour' },
        { ingredientName: 'Buttermilk' },
        { ingredientName: 'Eggs' },
      ],
    });
    assert.equal(updated.updateRecipe.title, 'Buttermilk Pancakes');
    assert.deepEqual(
      updated.updateRecipe.ingredients.map((i) => i.ingredientName).sort(),
      ['Buttermilk', 'Eggs', 'Flour'],
    );
  });

  it('deletes a recipe and removes it from listings', async () => {
    const created = await gql<{ createRecipe: { id: string } }>(CREATE, {
      title: 'Doomed Dish',
      instructions: 'x',
      ingredients: [],
    });
    const { deleteRecipe } = await gql<{ deleteRecipe: boolean }>(DELETE, {
      id: created.createRecipe.id,
    });
    assert.equal(deleteRecipe, true);

    const { recipes } = await gql<{ recipes: { title: string }[] }>(LIST);
    assert.ok(!recipes.some((r) => r.title === 'Doomed Dish'));
  });

  it('filters by tag (array overlap)', async () => {
    await gql(CREATE, {
      title: 'Bean Tacos',
      instructions: 'Wrap',
      ingredients: [],
      tags: ['mexican', 'vegetarian'],
    });
    await gql(CREATE, {
      title: 'Beef Tacos',
      instructions: 'Wrap',
      ingredients: [],
      tags: ['mexican'],
    });
    await gql(CREATE, {
      title: 'Tofu Stir Fry',
      instructions: 'Fry',
      ingredients: [],
      tags: ['asian', 'vegetarian'],
    });
    const { recipes } = await gql<{ recipes: { title: string }[] }>(LIST, {
      tags: ['vegetarian'],
    });
    assert.deepEqual(recipes.map((r) => r.title).sort(), [
      'Bean Tacos',
      'Tofu Stir Fry',
    ]);
  });

  it('filters by title substring (ILIKE)', async () => {
    await gql(CREATE, {
      title: 'Apple Pie',
      instructions: 'Bake',
      ingredients: [],
    });
    await gql(CREATE, {
      title: 'Apple Crumble',
      instructions: 'Bake',
      ingredients: [],
    });
    await gql(CREATE, {
      title: 'Cherry Pie',
      instructions: 'Bake',
      ingredients: [],
    });
    const { recipes } = await gql<{ recipes: { title: string }[] }>(LIST, {
      title: 'apple',
    });
    assert.deepEqual(recipes.map((r) => r.title).sort(), [
      'Apple Crumble',
      'Apple Pie',
    ]);
  });
});
