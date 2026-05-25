import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HarnessHandle {
  url: string;
  dbPath: string;
  mockUrl: string;
  serverPid?: number;
  // Set when run.ts is in docker mode (INTEGRATION_SERVER_IMAGE). resetDb()
  // shells out to `docker exec <containerId>` instead of opening the
  // bind-mounted SQLite file from the host — opening it across Docker
  // Desktop's bind-mount doesn't coordinate WAL locks reliably.
  containerId?: string;
}

const FILE = join(import.meta.dirname, '..', '__harness__.json');
let cached: HarnessHandle | undefined;

export function harness(): HarnessHandle {
  if (!cached) {
    cached = JSON.parse(readFileSync(FILE, 'utf8')) as HarnessHandle;
  }
  return cached;
}
