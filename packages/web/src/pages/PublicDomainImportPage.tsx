import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { fetchPublicDomainRecipe } from '@pantry-host/shared/publicdomainrecipes';
import type { ParsedRecipe } from '@pantry-host/shared/bluesky';
import { gql } from '@/lib/gql';

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

const RECIPES_QUERY = `{ recipes { id slug sourceUrl } }`;

export default function PublicDomainImportPage() {
  const { slug, kitchen: kitchenParam } = useParams<{ slug: string; kitchen?: string }>();
  const kitchen = kitchenParam ?? 'home';
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY);
      return data.recipes.find((r) => r.sourceUrl === sourceUrl)?.slug ?? null;
    } catch { return null; }
  }, []);

  const load = useCallback(async () => {
    if (!slug) return;
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

  const renderRecipeLink = useCallback((slugOut: string, children: React.ReactNode) => (
    <Link to={`/kitchens/${kitchen}/recipes/${slugOut}#stage`}>{children}</Link>
  ), [kitchen]);

  if (!slug) return <div className="max-w-3xl mx-auto py-12 px-4">Missing recipe slug.</div>;

  return (
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
  );
}
