import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const CREATE = `
  mutation C($slug: String!, $name: String!) {
    createKitchen(slug: $slug, name: $name) { id slug name }
  }
`;
const LIST = `query { kitchens { slug name } }`;
const UPDATE = `
  mutation U($id: String!, $name: String!) {
    updateKitchen(id: $id, name: $name) { id name }
  }
`;
const DELETE = `mutation D($id: String!) { deleteKitchen(id: $id) }`;
const ONE = `query One($slug: String!) { kitchen(slug: $slug) { slug name } }`;

describe('kitchens CRUD', () => {
  beforeEach(() => resetDb());

  it('the seeded home kitchen always exists', async () => {
    const { kitchen } = await gql<{
      kitchen: { slug: string; name: string } | null;
    }>(ONE, { slug: 'home' });
    assert.equal(kitchen?.slug, 'home');
    assert.equal(kitchen?.name, 'Home');
  });

  it('creates a new kitchen and lists it', async () => {
    await gql(CREATE, { slug: 'beach-house', name: 'Beach House' });
    const { kitchens } = await gql<{
      kitchens: { slug: string; name: string }[];
    }>(LIST);
    assert.equal(
      kitchens.find((k) => k.slug === 'beach-house')?.name,
      'Beach House',
    );
  });

  it('rejects the reserved "home" slug', async () => {
    await assert.rejects(
      gql(CREATE, { slug: 'home', name: 'Duplicate Home' }),
      /reserved/i,
    );
  });

  it('rejects invalid slug characters', async () => {
    await assert.rejects(gql(CREATE, { slug: 'Bad Slug!', name: 'X' }));
  });

  it('rejects a duplicate slug', async () => {
    await gql(CREATE, { slug: 'cabin', name: 'Cabin' });
    await assert.rejects(gql(CREATE, { slug: 'cabin', name: 'Other Cabin' }));
  });

  it('updates and deletes a non-home kitchen', async () => {
    const { createKitchen } = await gql<{ createKitchen: { id: string } }>(
      CREATE,
      { slug: 'studio', name: 'Studio' },
    );
    const { updateKitchen } = await gql<{ updateKitchen: { name: string } }>(
      UPDATE,
      { id: createKitchen.id, name: 'Studio Apartment' },
    );
    assert.equal(updateKitchen.name, 'Studio Apartment');

    await gql(DELETE, { id: createKitchen.id });
    const { kitchens } = await gql<{ kitchens: { slug: string }[] }>(LIST);
    assert.ok(!kitchens.some((k) => k.slug === 'studio'));
  });
});
