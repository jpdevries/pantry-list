import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const ADD = `
  mutation Add($name: String!, $tags: [String!]) {
    addIngredient(name: $name, tags: $tags) { id name tags }
  }
`;
const LIST = `
  query List($name: String, $tags: [String!]) {
    ingredients(name: $name, tags: $tags) { id name tags }
  }
`;
const UPDATE = `
  mutation Update($id: String!, $name: String) {
    updateIngredient(id: $id, name: $name) { id name }
  }
`;
const DELETE = `mutation Del($id: String!) { deleteIngredient(id: $id) }`;
const ADD_BULK = `
  mutation AddBulk($inputs: [IngredientInput!]!) {
    addIngredients(inputs: $inputs) { id name }
  }
`;

describe('ingredients CRUD', () => {
  beforeEach(() => resetDb());

  it('adds an ingredient and lists it', async () => {
    const { addIngredient } = await gql<{
      addIngredient: { id: string; name: string; tags: string[] };
    }>(ADD, { name: 'Eggs', tags: ['fridge'] });
    assert.equal(addIngredient.name, 'Eggs');
    assert.deepEqual(addIngredient.tags, ['fridge']);

    const { ingredients } = await gql<{ ingredients: { name: string }[] }>(LIST);
    assert.ok(ingredients.some((i) => i.name === 'Eggs'));
  });

  it('updates an ingredient name', async () => {
    const { addIngredient } = await gql<{ addIngredient: { id: string } }>(
      ADD,
      { name: 'Tomato' },
    );
    const { updateIngredient } = await gql<{
      updateIngredient: { name: string };
    }>(UPDATE, { id: addIngredient.id, name: 'Heirloom Tomato' });
    assert.equal(updateIngredient.name, 'Heirloom Tomato');
  });

  it('deletes an ingredient', async () => {
    const { addIngredient } = await gql<{ addIngredient: { id: string } }>(
      ADD,
      { name: 'Bread' },
    );
    const { deleteIngredient } = await gql<{ deleteIngredient: boolean }>(
      DELETE,
      { id: addIngredient.id },
    );
    assert.equal(deleteIngredient, true);

    const { ingredients } = await gql<{ ingredients: { name: string }[] }>(LIST);
    assert.ok(!ingredients.some((i) => i.name === 'Bread'));
  });

  it('bulk inserts ingredients', async () => {
    const inputs = ['Salt', 'Pepper', 'Olive Oil', 'Garlic', 'Onion'].map(
      (name) => ({ name }),
    );
    const { addIngredients } = await gql<{
      addIngredients: { id: string; name: string }[];
    }>(ADD_BULK, { inputs });
    assert.equal(addIngredients.length, 5);
    assert.deepEqual(addIngredients.map((i) => i.name).sort(), [
      'Garlic',
      'Olive Oil',
      'Onion',
      'Pepper',
      'Salt',
    ]);
  });

  it('filters by name (ILIKE substring, case-insensitive)', async () => {
    await gql(ADD, { name: 'Pickled Onions' });
    await gql(ADD, { name: 'Red Onion' });
    await gql(ADD, { name: 'Garlic' });
    const { ingredients } = await gql<{ ingredients: { name: string }[] }>(
      LIST,
      { name: 'onion' },
    );
    assert.deepEqual(ingredients.map((i) => i.name).sort(), [
      'Pickled Onions',
      'Red Onion',
    ]);
  });

  it('filters by tags (array containment)', async () => {
    await gql(ADD, { name: 'Milk', tags: ['fridge', 'dairy'] });
    await gql(ADD, { name: 'Butter', tags: ['fridge', 'dairy'] });
    await gql(ADD, { name: 'Flour', tags: ['pantry'] });
    const { ingredients } = await gql<{ ingredients: { name: string }[] }>(
      LIST,
      { tags: ['dairy'] },
    );
    assert.deepEqual(ingredients.map((i) => i.name).sort(), [
      'Butter',
      'Milk',
    ]);
  });
});
