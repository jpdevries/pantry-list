import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fetchAsOwner, fetchAsGuest, parseJson } from './helpers/http.ts';
import { harness } from './helpers/harness.ts';

// Tests share the overrides file across cases. Reset it before/after the
// suite so other test files (e.g. recipe-api-key) start from a known state.
function overridesPath(): string {
  return join(dirname(harness().dbPath), '.settings-overrides.json');
}

function clearOverrides(): void {
  try {
    unlinkSync(overridesPath());
  } catch {
    /* not present — fine */
  }
}

describe('GET /api/settings-read', () => {
  before(clearOverrides);
  after(clearOverrides);

  it('owner read returns full schema with secrets masked', async () => {
    const res = await fetchAsOwner('/api/settings-read');
    assert.equal(res.status, 200);
    const body = parseJson<{
      locked: boolean;
      values: Record<string, string | null>;
      maskedKeys: string[];
    }>(res);
    assert.equal(body.locked, false);
    assert.deepEqual(
      [...body.maskedKeys].sort(),
      ['PIXABAY_API_KEY', 'RECIPE_API_KEY'],
      'both secrets should be flagged as masked',
    );
    // Mask pattern: first 8 chars + 8 bullets + last 5 chars. The trailing
    // 5 chars include the underscore boundary in our test values.
    assert.match(body.values.RECIPE_API_KEY ?? '', /^rapi_tes•{8}_mask$/);
    assert.match(body.values.PIXABAY_API_KEY ?? '', /^pixabay_•{8}nough$/);
    // Unset settings come back as null, not undefined.
    assert.equal(body.values.HARVEST_LOCATIONS, null);
    assert.equal(body.values.SHOW_COCKTAILDB, null);
  });

  it('guest read is locked: {locked: true, values: null}', async () => {
    const res = await fetchAsGuest('/api/settings-read');
    assert.equal(res.status, 200);
    const body = parseJson<{ locked: boolean; values: null }>(res);
    assert.equal(body.locked, true);
    assert.equal(body.values, null);
  });

  it('?reveal=KEY returns the unmasked value to an owner', async () => {
    const res = await fetchAsOwner('/api/settings-read?reveal=RECIPE_API_KEY');
    assert.equal(res.status, 200);
    const body = parseJson<{ locked: boolean; key: string; value: string }>(res);
    assert.equal(body.locked, false);
    assert.equal(body.key, 'RECIPE_API_KEY');
    assert.equal(body.value, 'rapi_test_secret_12345_long_enough_to_mask');
  });

  it('?reveal=BAD_KEY → 400 with explanatory error', async () => {
    const res = await fetchAsOwner('/api/settings-read?reveal=NOPE_KEY');
    assert.equal(res.status, 400);
    const body = parseJson<{ error: string }>(res);
    assert.match(body.error, /Unknown setting key/i);
  });

  it('Cache-Control is private,no-store so secrets never land in shared caches', async () => {
    const res = await fetchAsOwner('/api/settings-read');
    assert.match(String(res.headers['cache-control'] ?? ''), /private/);
    assert.match(String(res.headers['cache-control'] ?? ''), /no-store/);
  });
});

describe('POST /api/settings-write', () => {
  before(clearOverrides);
  after(clearOverrides);

  it('JSON write persists overrides and read merges them on top of env', async () => {
    const res = await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: {
          SHOW_COCKTAILDB: 'false',
          HARVEST_LOCATIONS: 'garden, costco',
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(parseJson(res), { ok: true });

    // Read picks up the override without a server restart.
    const followup = await fetchAsOwner('/api/settings-read');
    const body = parseJson<{ values: Record<string, string | null> }>(followup);
    assert.equal(body.values.SHOW_COCKTAILDB, 'false');
    assert.equal(body.values.HARVEST_LOCATIONS, 'garden, costco');
  });

  it('empty/null value deletes the override (back to env-derived fallback)', async () => {
    // Seed an override that clobbers the env-derived value.
    await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { RECIPE_API_KEY: 'override_value' } }),
    });
    let read = await fetchAsOwner(
      '/api/settings-read?reveal=RECIPE_API_KEY',
    );
    assert.equal(
      parseJson<{ value: string }>(read).value,
      'override_value',
      'override should win over env',
    );
    // Now blank it out — should fall back to the env value.
    await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { RECIPE_API_KEY: '' } }),
    });
    read = await fetchAsOwner('/api/settings-read?reveal=RECIPE_API_KEY');
    assert.equal(
      parseJson<{ value: string }>(read).value,
      'rapi_test_secret_12345_long_enough_to_mask',
      'after delete, env-derived value should reappear',
    );
  });

  it('form-encoded POST redirects to /settings (the Settings page submit path)', async () => {
    const res = await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'HARVEST_LOCATIONS=garden&PREFER_BROWSER_CHROME=on',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/settings');
  });

  it('form-encoded POST treats absent boolean keys as "false" (unchecked checkbox)', async () => {
    // Submit only HARVEST_LOCATIONS — every boolean checkbox is implicitly
    // unchecked and should land as "false" in overrides.
    await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'HARVEST_LOCATIONS=farm',
    });
    const read = await fetchAsOwner('/api/settings-read');
    const body = parseJson<{ values: Record<string, string | null> }>(read);
    assert.equal(body.values.SHOW_COCKTAILDB, 'false');
    assert.equal(body.values.PIXABAY_FALLBACK_ENABLED, 'false');
    assert.equal(body.values.STORE_BARCODE_META, 'false');
    assert.equal(body.values.PREFER_BROWSER_CHROME, 'false');
  });

  it('__UNCHANGED__ sentinel preserves the existing override for that key', async () => {
    await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        values: { HARVEST_LOCATIONS: 'home, garden' },
      }),
    });
    // Submit __UNCHANGED__ for HARVEST_LOCATIONS — should not change.
    await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'HARVEST_LOCATIONS=__UNCHANGED__',
    });
    const read = await fetchAsOwner('/api/settings-read');
    const body = parseJson<{ values: Record<string, string | null> }>(read);
    assert.equal(body.values.HARVEST_LOCATIONS, 'home, garden');
  });

  it('guest write is forbidden with 403', async () => {
    const res = await fetchAsGuest('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { SHOW_COCKTAILDB: 'true' } }),
    });
    assert.equal(res.status, 403);
  });

  it('unknown setting key in JSON values is rejected with 400', async () => {
    const res = await fetchAsOwner('/api/settings-write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: { ARBITRARY_ENV_VAR: 'evil' } }),
    });
    // The body contains no allowed keys, so the parser reports "Missing
    // values" rather than reaching the per-key allowlist check — that's
    // still a 400, which is the contract we care about.
    assert.equal(res.status, 400);
  });
});

describe('GET /api/recipe-api-key', () => {
  it('owner gets the raw key', async () => {
    const res = await fetchAsOwner('/api/recipe-api-key');
    assert.equal(res.status, 200);
    const body = parseJson<{ key: string | null }>(res);
    assert.equal(body.key, 'rapi_test_secret_12345_long_enough_to_mask');
  });

  it('guest gets {key: null} (200, not 403 — client treats null as "hide tab")', async () => {
    const res = await fetchAsGuest('/api/recipe-api-key');
    assert.equal(res.status, 200);
    const body = parseJson<{ key: string | null }>(res);
    assert.equal(body.key, null);
  });
});
