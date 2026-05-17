import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

const ADD = `
  mutation Add($name: String!, $brand: String) {
    addCookware(name: $name, brand: $brand) { id name brand }
  }
`;
const LIST = `query { cookware { id name brand } }`;
const UPDATE = `
  mutation U($id: String!, $brand: String) {
    updateCookware(id: $id, brand: $brand) { id brand }
  }
`;
const DELETE = `mutation D($id: String!) { deleteCookware(id: $id) }`;

describe('cookware CRUD', () => {
  beforeEach(() => resetDb());

  it('creates, updates, lists, and deletes a cookware item', async () => {
    const { addCookware } = await gql<{
      addCookware: { id: string; name: string; brand: string | null };
    }>(ADD, { name: 'Cast Iron Skillet' });
    assert.equal(addCookware.name, 'Cast Iron Skillet');
    assert.equal(addCookware.brand, null);

    const { updateCookware } = await gql<{
      updateCookware: { brand: string };
    }>(UPDATE, { id: addCookware.id, brand: 'Lodge' });
    assert.equal(updateCookware.brand, 'Lodge');

    const { cookware: list1 } = await gql<{
      cookware: { name: string; brand: string | null }[];
    }>(LIST);
    assert.equal(
      list1.find((c) => c.name === 'Cast Iron Skillet')?.brand,
      'Lodge',
    );

    const { deleteCookware } = await gql<{ deleteCookware: boolean }>(DELETE, {
      id: addCookware.id,
    });
    assert.equal(deleteCookware, true);

    const { cookware: list2 } = await gql<{ cookware: { name: string }[] }>(
      LIST,
    );
    assert.ok(!list2.some((c) => c.name === 'Cast Iron Skillet'));
  });
});
