import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HarnessHandle {
  url: string;
  dbPath: string;
  mockUrl: string;
  serverPid: number;
}

const FILE = join(import.meta.dirname, '..', '__harness__.json');
let cached: HarnessHandle | undefined;

export function harness(): HarnessHandle {
  if (!cached) {
    cached = JSON.parse(readFileSync(FILE, 'utf8')) as HarnessHandle;
  }
  return cached;
}
