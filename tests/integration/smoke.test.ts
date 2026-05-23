import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';

describe('smoke', () => {
  it('GraphQL endpoint responds with schema introspection', async () => {
    const data = await gql<{
      __schema: {
        queryType: { name: string };
        mutationType: { name: string } | null;
      };
    }>(`{ __schema { queryType { name } mutationType { name } } }`);
    assert.equal(data.__schema.queryType.name, 'Query');
    assert.equal(data.__schema.mutationType?.name, 'Mutation');
  });

  it('Query.kitchens returns the seeded home kitchen', async () => {
    const data = await gql<{ kitchens: { slug: string; name: string }[] }>(
      `{ kitchens { slug name } }`,
    );
    const home = data.kitchens.find((k) => k.slug === 'home');
    assert.ok(home, 'home kitchen present');
    assert.equal(home.name, 'Home');
  });

  // Bluesky / AT Protocol is UI-only — no GraphQL surface to integration-test.
});
