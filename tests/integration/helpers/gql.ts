import { harness } from './harness.ts';

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export async function gql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { url } = harness();
  const r = await fetch(`${url}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} from /graphql: ${await r.text()}`);
  }
  const body = (await r.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(
      `GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (body.data === undefined) {
    throw new Error('GraphQL response missing data field');
  }
  return body.data;
}
