import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const CREATE = `
  mutation Create($title: String!) {
    createRecipe(title: $title, instructions: "x", ingredients: []) {
      id queued lastMadeAt
    }
  }
`;
const TOGGLE = `
  mutation Toggle($id: String!) {
    toggleRecipeQueued(id: $id) { id queued }
  }
`;
const COMPLETE = `
  mutation Complete($id: String!) {
    completeRecipe(id: $id) { id lastMadeAt }
  }
`;

describe('recipe lifecycle', () => {
  beforeEach(() => resetDb());

  it('toggles queued on and off', async () => {
    const { createRecipe } = await gql<{
      createRecipe: { id: string; queued: boolean };
    }>(CREATE, { title: 'Roast Chicken' });
    assert.equal(createRecipe.queued, false);

    const t1 = await gql<{ toggleRecipeQueued: { queued: boolean } }>(TOGGLE, {
      id: createRecipe.id,
    });
    assert.equal(t1.toggleRecipeQueued.queued, true);

    const t2 = await gql<{ toggleRecipeQueued: { queued: boolean } }>(TOGGLE, {
      id: createRecipe.id,
    });
    assert.equal(t2.toggleRecipeQueued.queued, false);
  });

  it('stamps lastMadeAt to a recent timestamp on completeRecipe', async () => {
    const { createRecipe } = await gql<{
      createRecipe: { id: string; lastMadeAt: string | null };
    }>(CREATE, { title: 'Lentil Soup' });
    assert.equal(createRecipe.lastMadeAt, null);

    const { completeRecipe } = await gql<{
      completeRecipe: { lastMadeAt: string | null };
    }>(COMPLETE, { id: createRecipe.id });

    assert.notEqual(completeRecipe.lastMadeAt, null);
    const dt = new Date(completeRecipe.lastMadeAt!).getTime();
    assert.ok(Date.now() - dt < 10_000);
  });
});
