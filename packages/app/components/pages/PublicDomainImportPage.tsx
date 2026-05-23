/**
 * PublicDomainRecipes single-recipe import preview page.
 *
 * Mirrors MealdbImportPage. Public Domain content has no auth gate and
 * fetches static files from a GitHub raw URL via fetchPublicDomainRecipe.
 */
import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { fetchPublicDomainRecipe } from '@pantry-host/shared/publicdomainrecipes';
import type { ParsedRecipe } from '@pantry-host/shared/bluesky';
import { gql } from '@/lib/gql';
import { useKitchen } from '@/lib/kitchen-context';
import { isBrowser } from '@pantry-host/shared/env';

const CREATE_RECIPE = `
  mutation CreateRecipe(
    $title: String!, $description: String, $instructions: String!,
    $servings: Int, $prepTime: Int, $cookTime: Int,
    $tags: [String!], $photoUrl: String, $sourceUrl: String,
    $ingredients: [RecipeIngredientInput!]!, $kitchenSlug: String
  ) {
    createRecipe(
      title: $title, description: $description, instructions: $instructions,
      servings: $servings, prepTime: $prepTime, cookTime: $cookTime,
      tags: $tags, photoUrl: $photoUrl, sourceUrl: $sourceUrl,
      ingredients: $ingredients, kitchenSlug: $kitchenSlug
    ) { id slug }
  }
`;

const RECIPES_QUERY = `query($kitchenSlug:String){ recipes(kitchenSlug:$kitchenSlug){ id slug sourceUrl } }`;

interface Props { slug: string; }

export default function PublicDomainImportPage({ slug }: Props) {
  const kitchen = useKitchen();
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = isBrowser ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY, { kitchenSlug: kitchen });
      return data.recipes.find((r) => r.sourceUrl === sourceUrl)?.slug ?? null;
    } catch { return null; }
  }, [kitchen]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const pd = await fetchPublicDomainRecipe(slug);
      const recipe: ParsedRecipe = {
        title: pd.title,
        description: undefined,
        instructions: pd.instructions,
        tags: pd.tags,
        photoUrl: pd.imageUrl ?? undefined,
        sourceUrl: pd.sourceUrl,
        ingredients: pd.ingredients,
      };
      const dup = await checkDuplicate(recipe.sourceUrl);
      setExistingSlug(dup);
      setState({ kind: 'recipe', recipe });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [slug, checkDuplicate]);

  useEffect(() => { load(); }, [load]);

  async function handleImport() {
    if (state.kind !== 'recipe') return;
    const { recipe } = state;
    setState({ kind: 'importing', recipe });
    try {
      const data = await gql<{ createRecipe: { id: string; slug: string } }>(CREATE_RECIPE, {
        title: recipe.title,
        description: recipe.description ?? null,
        instructions: recipe.instructions,
        servings: recipe.servings ?? null,
        prepTime: recipe.prepTime ?? null,
        cookTime: recipe.cookTime ?? null,
        tags: recipe.tags,
        photoUrl: recipe.photoUrl ?? null,
        sourceUrl: recipe.sourceUrl,
        ingredients: recipe.ingredients.map((i) => ({
          ingredientName: i.ingredientName,
          quantity: i.quantity ?? null,
          unit: i.unit ?? null,
        })),
        kitchenSlug: kitchen,
      });
      setState({ kind: 'imported', slug: data.createRecipe.slug });
    } catch (err) {
      setState({ kind: 'error', message: `Import failed: ${(err as Error).message}` });
    }
  }

  const renderRecipeLink = useCallback((slug: string, children: React.ReactNode) => (
    <a href={`/kitchens/${kitchen}/recipes/${slug}#stage`}>{children}</a>
  ), [kitchen]);

  return (
    <>
      <Head>
        <title>Import Recipe | Pantry Host</title>
        <meta name="description" content="Preview a public-domain recipe before importing." />
      </Head>
      <ImportPreview
        state={state}
        sourceLabel="Public Domain Recipes"
        sourceAttributionUrl={`https://publicdomainrecipes.com/${slug}/`}
        attributionLabel="publicdomainrecipes.com"
        shareUrl={shareUrl}
        existingSlug={existingSlug}
        onImport={handleImport}
        onRetry={load}
        renderRecipeLink={renderRecipeLink}
      />
    </>
  );
}
