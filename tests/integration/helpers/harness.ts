import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HarnessHandle {
  url: string;
  dbUrl: string;
  mockUrl: string;
  serverPid: number;
  containerId: string;
  containerName: string;
  dbName: string;
  dbUser: string;
}

const FILE = join(import.meta.dirname, '..', '__harness__.json');
let cached: HarnessHandle | undefined;

export function harness(): HarnessHandle {
  if (!cached) {
    cached = JSON.parse(readFileSync(FILE, 'utf8')) as HarnessHandle;
  }
  return cached;
}
