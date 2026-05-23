/**
 * Generic recipe import preview + CTA.
 *
 * Renders a full recipe detail view for any non-AT source (MealDB,
 * CocktailDB, Recipe-API, PublicDomain, Wikibooks, Cooklang). Used by
 * the per-source `/import/{source}/{id}` routes in both packages.
 *
 * Mirrors the shape of AtRecipeDetail so the browse-before-import UX
 * feels identical across sources. The two components stay parallel for
 * now; future cleanup can lift the shared body into a single primitive.
 *
 * The caller provides:
 * - `state`: load/recipe/error — caller owns the fetch lifecycle
 * - `sourceLabel`: e.g. "TheMealDB", "Wikibooks"
 * - `sourceAttributionUrl`: optional link back to the canonical source page
 * - `attributionLabel`: e.g. "themealdb.com" — display text for the source link
 * - `shareUrl`: full page URL for QR / clipboard share (this preview URL)
 * - `existingSlug`: non-null if a recipe with this sourceUrl already exists locally
 * - `onImport()`: trigger the createRecipe mutation
 * - `renderRecipeLink(slug, children)`: navigate to a local recipe — app <a>, web router
 */
import { useState } from 'react';
import { type ParsedRecipe } from '../bluesky';
import { groupIngredients } from '../ingredient-groups';
import QRCodeModal from './QRCodeModal';
import { ShareNetwork, ArrowSquareIn, Warning, SpinnerGap } from '@phosphor-icons/react';

export type ImportPreviewState =
  | { kind: 'loading' }
  | { kind: 'recipe'; recipe: ParsedRecipe }
  | { kind: 'importing'; recipe: ParsedRecipe }
  | { kind: 'imported'; slug: string }
  | { kind: 'error'; message: string };

interface ImportPreviewProps {
  state: ImportPreviewState;
  sourceLabel: string;
  sourceAttributionUrl?: string;
  attributionLabel?: string;
  shareUrl: string;
  existingSlug: string | null;
  onImport: () => Promise<void>;
  onRetry?: () => void;
  renderRecipeLink: (slug: string, children: React.ReactNode) => React.ReactNode;
}

export default function ImportPreview({
  state,
  sourceLabel,
  sourceAttributionUrl,
  attributionLabel,
  shareUrl,
  existingSlug,
  onImport,
  onRetry,
  renderRecipeLink,
}: ImportPreviewProps) {
  const [qrOpen, setQrOpen] = useState(false);

  // ── Loading ──
  if (state.kind === 'loading') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 flex items-center gap-3 text-[var(--color-text-secondary)]">
        <SpinnerGap size={20} className="animate-spin" />
        Fetching recipe from {sourceLabel}…
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
            <p className="font-semibold mb-1">Couldn't load recipe</p>
            <p className="text-sm text-[var(--color-text-secondary)] legible pretty">{state.message}</p>
            {onRetry && (
              <button onClick={onRetry} className="btn-secondary text-sm mt-3">Try again</button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Imported — redirect ──
  if (state.kind === 'imported') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="card p-6 text-center">
          <p className="font-semibold mb-2">Recipe imported</p>
          {renderRecipeLink(state.slug, (
            <span className="text-accent hover:underline">View in your pantry →</span>
          ))}
        </div>
      </div>
    );
  }

  // ── Recipe detail (recipe or importing state) ──
  const recipe = state.recipe;
  const importing = state.kind === 'importing';

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      {/* ── Import CTA bar ── */}
      <div className="card p-4 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-[var(--color-text-secondary)] break-words min-w-0">
            from{' '}
            {sourceAttributionUrl ? (
              <a
                href={sourceAttributionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {attributionLabel ?? sourceLabel}
              </a>
            ) : (
              <span>{attributionLabel ?? sourceLabel}</span>
            )}
          </span>
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
            renderRecipeLink(existingSlug, (
              <span className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5">
                Already in your pantry →
              </span>
            ))
          ) : (
            <button
              onClick={onImport}
              disabled={importing}
              className="btn-primary text-sm flex items-center justify-center gap-1.5"
            >
              <ArrowSquareIn size={16} />
              {importing ? 'Importing…' : 'Import to your pantry'}
            </button>
          )}
        </div>
      </div>

      {/* ── Photo ── */}
      {recipe.photoUrl && (
        <img
          src={recipe.photoUrl}
          alt={recipe.title}
          className="w-full rounded-xl mb-6 object-cover max-h-96"
          loading="lazy"
        />
      )}

      {/* ── Title ── */}
      <h1 className="text-3xl font-bold mb-2">{recipe.title}</h1>

      {/* ── Meta ── */}
      <div className="flex flex-wrap gap-4 text-sm text-[var(--color-text-secondary)] mb-6">
        {recipe.servings != null && <span>Serves {recipe.servings}</span>}
        {recipe.prepTime != null && <span>Prep {recipe.prepTime}m</span>}
        {recipe.cookTime != null && <span>Cook {recipe.cookTime}m</span>}
      </div>

      {/* ── Description ── */}
      {recipe.description && (
        <p className="text-[var(--color-text-secondary)] mb-6 legible pretty whitespace-pre-line">
          {recipe.description}
        </p>
      )}

      {/* ── Tags ── */}
      {recipe.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {recipe.tags.map((tag) => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      )}

      {/* ── Ingredients ── */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">Ingredients</h2>
        {groupIngredients(recipe.ingredients).map((g, gi) => {
          const list = (
            // Inline list-style + padding on the <ul> — Tailwind v4
            // preflight zeroes `list-style`, `margin`, and `padding` on
            // every ul, and the `list-disc` / `pl-6` utilities get
            // reliably stripped when this shared component renders
            // through Rex's scanner. Inline styles win the specificity
            // fight and render identically in every consumer. Mirrors
            // the workaround in AtRecipeDetail.
            <ul
              className="marker:text-[var(--color-text-secondary)]"
              style={{ listStyleType: 'disc', paddingInlineStart: '1.5rem' }}
            >
              {g.items.map((ing, ii) => (
                <li key={ii} className="text-sm pl-1" style={{ marginBlockEnd: '0.3125rem', lineHeight: '1.6' }}>
                  {ing.quantity != null && <span className="font-medium">{Math.round(ing.quantity * 100) / 100}</span>}
                  {ing.unit && <span className="text-[var(--color-text-secondary)]"> {ing.unit}</span>}
                  {' '}{ing.ingredientName}
                </li>
              ))}
            </ul>
          );
          if (!g.group) return <div key={`g-${gi}`}>{list}</div>;
          return (
            <fieldset key={`g-${gi}`} className="mt-4 first:mt-0">
              <legend className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">{g.group}</legend>
              {list}
            </fieldset>
          );
        })}
      </section>

      {/* ── Instructions ── */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-3">Instructions</h2>
        <ol className="list-decimal pl-6 space-y-3 text-[var(--color-text-primary)] legible pretty marker:text-[var(--color-text-secondary)]">
          {recipe.instructions.split(/\n+/).filter((s) => s.trim()).map((step, i) => (
            <li key={i} className="text-sm pl-1">{step.replace(/^\d+\.\s*/, '')}</li>
          ))}
        </ol>
      </section>

      {/* ── Source link ── */}
      {recipe.sourceUrl && (
        <p className="text-xs text-[var(--color-text-secondary)]">
          Source:{' '}
          <a
            href={recipe.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {recipe.sourceUrl}
          </a>
        </p>
      )}

      <QRCodeModal url={shareUrl} open={qrOpen} onClose={() => setQrOpen(false)} />
    </div>
  );
}
