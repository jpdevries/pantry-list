import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Minimal valid 1x1 transparent PNG.
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const UPLOADS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  'packages',
  'app',
  'public',
  'uploads',
);

describe('POST /upload', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const filename of created) {
      try {
        unlinkSync(join(UPLOADS_DIR, filename));
      } catch {
        /* file may have been removed by another test step */
      }
    }
    created.length = 0;
  });

  it('accepts a PNG upload and returns a /uploads/<uuid>.png URL', async () => {
    const { url } = harness();
    const form = new FormData();
    form.append(
      'file',
      new Blob([PNG_1X1], { type: 'image/png' }),
      'test.png',
    );
    const r = await fetch(`${url}/upload`, { method: 'POST', body: form });
    assert.ok(r.ok);

    const data = (await r.json()) as { url: string };
    assert.match(data.url, /^\/uploads\/[0-9a-f-]{36}\.png$/);
    created.push(data.url.replace('/uploads/', ''));
  });

  it('rejects unsupported file extensions', async () => {
    const { url } = harness();
    const form = new FormData();
    form.append(
      'file',
      new Blob([Buffer.from('not really a tiff')], { type: 'image/tiff' }),
      'test.tiff',
    );
    const r = await fetch(`${url}/upload`, { method: 'POST', body: form });
    assert.equal(r.status, 400);
  });

  it('returns 400 when no file field is present', async () => {
    const { url } = harness();
    const form = new FormData();
    form.append('not-a-file', 'oops');
    const r = await fetch(`${url}/upload`, { method: 'POST', body: form });
    assert.equal(r.status, 400);
  });
});
