import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

// Anthropic SDK is redirected at the local mock via ANTHROPIC_BASE_URL.

const ADD_ING = `
  mutation AI($name: String!) {
    addIngredient(name: $name) { id name }
  }
`;
const ADD_COOK = `
  mutation AC($name: String!) {
    addCookware(name: $name) { id name }
  }
`;
const GENERATE = `
  mutation Generate {
    generateRecipes {
      id slug title tags source
      ingredients { ingredientName quantity unit }
    }
  }
`;
const LIST = `query { recipes { title source } }`;

describe('generateRecipes (Anthropic mocked via ANTHROPIC_BASE_URL)', () => {
  beforeEach(() => resetDb());

  it('persists the three mock recipes and tags them as ai-generated', async () => {
    await gql(ADD_ING, { name: 'Salt' });
    await gql(ADD_ING, { name: 'Pepper' });
    await gql(ADD_COOK, { name: 'Bowl' });

    const { generateRecipes } = await gql<{
      generateRecipes: {
        id: string;
        title: string;
        source: string;
        ingredients: { ingredientName: string }[];
      }[];
    }>(GENERATE);

    assert.equal(generateRecipes.length, 3);
    assert.deepEqual(generateRecipes.map((r) => r.title).sort(), [
      'Mock Mixed Bowl',
      'Mock Pepper Bowl',
      'Mock Salt Bowl',
    ]);
    assert.ok(generateRecipes.every((r) => r.source === 'ai-generated'));

    const { recipes } = await gql<{
      recipes: { title: string; source: string }[];
    }>(LIST);
    assert.deepEqual(recipes.map((r) => r.title).sort(), [
      'Mock Mixed Bowl',
      'Mock Pepper Bowl',
      'Mock Salt Bowl',
    ]);
  });
});
