/**
 * Shared AT Protocol menu (collection) detail + import CTA.
 *
 * Sibling of `AtRecipeDetail`. Renders a full menu detail view for an
 * exchange.recipe.collection record fetched from the AT Protocol
 * network. Used by both packages/app (Rex) and packages/web (PGlite)
 * as the collection branch of the `/at/*` route handler.
 *
 * The caller provides:
 * - `atUri`: the canonical collection AT URI
 * - `shareUrl`: the full page URL for QR code
 * - `menuBasePath`: e.g. "/menus" — where successful imports redirect
 * - `recipeAtBase`: e.g. "/at" — base for member-recipe links
 * - `gql`: the package's GraphQL client (used by the shared
 *   `importBlueskyCollection` helper)
 * - `checkDuplicate(sourceUrl)`: return slug if this collection has
 *   already been imported, null otherwise
 * - `renderMenuLink(slug, children)`: navigate to a local menu — app
 *   uses <a href>, web uses React Router <Link>
 */
import { useState, useEffect, useCallback } from 'react';
import {
  fetchBlueskyCollection,
  fetchBlueskyRecipe,
  parseAtUri,
  type ParsedRecipe,
} from '../bluesky';
import { importBlueskyCollection } from '../bluesky-import';
import QRCodeModal from './QRCodeModal';
import { ShareNetwork, ArrowSquareIn, Warning, SpinnerGap } from '@phosphor-icons/react';

type GqlFn = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

interface AtMenuDetailProps {
  atUri: string;
  shareUrl: string;
  menuBasePath: string;
  recipeAtBase: string;
  gql: GqlFn;
  /** Slug of the kitchen the imported menu should land in. Threaded
   *  through from the caller's route params — e.g. `/kitchens/bar/at/…`
   *  → `'bar'`. Defaults to `'home'`, which is a real kitchen slug. */
  kitchenSlug: string;
  checkDuplicate: (sourceUrl: string) => Promise<string | null>;
  renderMenuLink: (slug: string, children: React.ReactNode) => React.ReactNode;
}

interface CollectionMeta {
  name: string;
  description: string | null;
  handle?: string;
  recipeUris: string[];
}

type MemberRecipe =
  | { status: 'loading'; atUri: string }
  | { status: 'ok'; atUri: string; recipe: ParsedRecipe }
  | { status: 'unavailable'; atUri: string };

type PageState =
  | { kind: 'loading' }
  | { kind: 'menu'; meta: CollectionMeta; members: MemberRecipe[]; existingSlug: string | null }
  | { kind: 'importing'; meta: CollectionMeta; members: MemberRecipe[]; progress: { done: number; total: number; label: string } }
  | { kind: 'imported'; slug: string }
  | { kind: 'error'; message: string };

// Bluesky butterfly mark.
const BLUESKY_VIEWBOX = '0 0 600 530';
const BLUESKY_PATH = 'M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z';

/** Convert an at:// URI into the Pantry Host deep-link path: /at/{did}/{collection}/{rkey}#stage */
function atUriToLocalPath(base: string, atUri: string): string {
  const parsed = parseAtUri(atUri);
  if (!parsed) return base;
  return `${base}/${parsed.repo}/${parsed.collection}/${parsed.rkey}#stage`;
}

export default function AtMenuDetail({
  atUri,
  shareUrl,
  menuBasePath: _menuBasePath,
  recipeAtBase,
  gql,
  kitchenSlug,
  checkDuplicate,
  renderMenuLink,
}: AtMenuDetailProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [qrOpen, setQrOpen] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const coll = await fetchBlueskyCollection(atUri);
      const existingSlug = await checkDuplicate(atUri);
      const meta: CollectionMeta = {
        name: coll.name,
        description: coll.description,
        handle: coll.handle,
        recipeUris: coll.recipeUris,
      };

      // Seed member slots in loading state so the UI can render
      // skeletons right away.
      const initialMembers: MemberRecipe[] = coll.recipeUris.map((u) => ({
        status: 'loading',
        atUri: u,
      }));
      setState({ kind: 'menu', meta, members: initialMembers, existingSlug });

      // Parallel-fetch each member recipe. Failures render as
      // "unavailable" — the lexicon allows cross-PDS references and
      // any author can delete their own record at any time.
      const settled = await Promise.allSettled(
        coll.recipeUris.map((u) => fetchBlueskyRecipe(u)),
      );
      const resolvedMembers: MemberRecipe[] = settled.map((r, i) => {
        const uri = coll.recipeUris[i];
        return r.status === 'fulfilled'
          ? { status: 'ok', atUri: uri, recipe: r.value }
          : { status: 'unavailable', atUri: uri };
      });
      setState((prev) => {
        // Don't clobber an in-flight import started before the member
        // fetches resolved.
        if (prev.kind !== 'menu') return prev;
        return { kind: 'menu', meta, members: resolvedMembers, existingSlug: prev.existingSlug };
      });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [atUri, checkDuplicate]);

  useEffect(() => { load(); }, [load]);

  async function handleImport() {
    if (state.kind !== 'menu') return;
    const { meta, members } = state;
    const total = meta.recipeUris.length + 1;
    setState({ kind: 'importing', meta, members, progress: { done: 0, total, label: 'Starting import…' } });
    try {
      const result = await importBlueskyCollection({
        atUri,
        gql,
        kitchenSlug,
        onProgress: (progress) => {
          setState({ kind: 'importing', meta, members, progress });
        },
      });
      setState({ kind: 'imported', slug: result.menuSlug });
    } catch (err) {
      setState({ kind: 'error', message: `Import failed: ${(err as Error).message}` });
    }
  }

  // ── Loading ──
  if (state.kind === 'loading') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 flex items-center gap-3 text-[var(--color-text-secondary)]">
        <SpinnerGap size={20} className="animate-spin" />
        Fetching menu from the AT Protocol network…
      </div>
    );
  }

  // ── Error ──
  if (state.kind === 'error') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="card p-6 flex items-start gap-3">
          <Warning size={20} className="shrink-0 mt-0.5 text-red-400" />
          <div>
            <p className="font-semibold mb-1">Couldn't load menu</p>
            <p className="text-sm text-[var(--color-text-secondary)] legible pretty">{state.message}</p>
            <button onClick={load} className="btn-secondary text-sm mt-3">Try again</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Imported — redirect prompt ──
  if (state.kind === 'imported') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="card p-6 text-center">
          <p className="font-semibold mb-2">Menu imported</p>
          {renderMenuLink(state.slug, (
            <span className="text-accent hover:underline">View in your pantry →</span>
          ))}
        </div>
      </div>
    );
  }

  // ── Menu detail (menu or importing state) ──
  const { meta, members } = state;
  const existingSlug = state.kind === 'menu' ? state.existingSlug : null;
  const importing = state.kind === 'importing';
  const progress = state.kind === 'importing' ? state.progress : null;

  const okCount = members.filter((m) => m.status === 'ok').length;
  const unavailableCount = members.filter((m) => m.status === 'unavailable').length;
  const loadingCount = members.filter((m) => m.status === 'loading').length;

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      {/* ── Import CTA bar (same mobile-friendly pattern as AtRecipeDetail) ── */}
      <div className="card p-4 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <svg
            fill="currentColor"
            viewBox={BLUESKY_VIEWBOX}
            width={20}
            height={18}
            aria-hidden="true"
            className="shrink-0 opacity-60 text-[var(--color-text-secondary)]"
          >
            <path d={BLUESKY_PATH} />
          </svg>
          {meta.handle && (
            <span className="text-sm text-[var(--color-text-secondary)] break-words min-w-0">
              by <a href={`https://bsky.app/profile/${meta.handle}`} target="_blank" rel="noopener noreferrer" className="underline">@{meta.handle}</a>
            </span>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:shrink-0">
          <button
            onClick={() => setQrOpen(true)}
            className="btn-secondary text-sm flex items-center justify-center gap-1.5"
            aria-label="Share QR code"
          >
            <ShareNetwork size={16} />
            Share
          </button>
          {existingSlug ? (
            renderMenuLink(existingSlug, (
              <span className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5">
                Already in your pantry →
              </span>
            ))
          ) : (
            <button
              onClick={handleImport}
              disabled={importing || loadingCount > 0}
              className="btn-primary text-sm flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              <ArrowSquareIn size={16} />
              {importing ? 'Importing…' : 'Import to your pantry'}
            </button>
          )}
        </div>
      </div>

      {/* ── Title ── */}
      <h1 className="text-3xl font-bold mb-2">{meta.name}</h1>

      {/* ── Meta ── */}
      <p className="text-sm text-[var(--color-text-secondary)] mb-4">
        {meta.recipeUris.length} {meta.recipeUris.length === 1 ? 'recipe' : 'recipes'}
        {unavailableCount > 0 && ` · ${unavailableCount} unavailable`}
      </p>

      {/* ── Description ── */}
      {meta.description && (
        <p className="text-[var(--color-text-secondary)] mb-6 legible pretty whitespace-pre-line">
          {meta.description}
        </p>
      )}

      {/* ── Import progress (when active) ── */}
      {importing && progress && (
        <div
          className="card p-3 mb-6 text-sm text-[var(--color-text-secondary)] flex items-center gap-3"
          role="status"
          aria-live="polite"
        >
          <SpinnerGap size={16} className="animate-spin shrink-0" />
          <span className="flex-1">{progress.label}</span>
          <span className="tabular-nums text-xs">{progress.done}/{progress.total}</span>
        </div>
      )}

      {/* ── Recipes in this menu ── */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">
          Recipes in this menu
          {loadingCount > 0 && (
            <span className="ml-2 text-xs text-[var(--color-text-secondary)] font-normal">
              · loading {okCount + unavailableCount}/{meta.recipeUris.length}
            </span>
          )}
        </h2>
        <ol className="space-y-2 list-decimal pl-5 marker:text-[var(--color-text-secondary)]">
          {members.map((m) => {
            if (m.status === 'loading') {
              return (
                <li key={m.atUri} className="pl-1">
                  <div className="card rounded-lg p-3 flex items-center gap-3 animate-pulse">
                    <SpinnerGap size={14} className="animate-spin shrink-0 text-[var(--color-text-secondary)]" />
                    <span className="text-sm text-[var(--color-text-secondary)]">Fetching recipe…</span>
                  </div>
                </li>
              );
            }
            if (m.status === 'unavailable') {
              return (
                <li key={m.atUri} className="pl-1">
                  <div className="card rounded-lg p-3 flex items-center gap-3 opacity-60">
                    <Warning size={14} className="shrink-0 text-[var(--color-text-secondary)]" />
                    <span className="text-sm text-[var(--color-text-secondary)] break-all">Recipe unavailable — <code className="text-xs">{m.atUri}</code></span>
                  </div>
                </li>
              );
            }
            const path = atUriToLocalPath(recipeAtBase, m.atUri);
            return (
              <li key={m.atUri} className="pl-1">
                <a
                  href={path}
                  className="card rounded-lg p-3 block hover:border-[var(--color-accent)] transition-colors"
                >
                  <h3 className="font-semibold text-sm mb-0.5">{m.recipe.title}</h3>
                  {m.recipe.description && (
                    <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">{m.recipe.description.replace(/\s*Shared by @[\w.-]+ on Bluesky.*$/s, '').trim()}</p>
                  )}
                </a>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── Source ── */}
      <p className="text-xs text-[var(--color-text-secondary)]">
        Source: <code className="text-xs break-all">{atUri}</code>
      </p>

      <QRCodeModal url={shareUrl} open={qrOpen} onClose={() => setQrOpen(false)} />
    </div>
  );
}
