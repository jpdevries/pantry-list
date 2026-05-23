import { useState, useEffect } from 'react';
import RecipeApiImportPage from '@/components/pages/RecipeApiImportPage';
import { isServer } from '@pantry-host/shared/env';

/** See pages/import/mealdb/[idMeal].tsx for why <main id="stage"> is
 *  rendered here synchronously. */
export default function RecipeApiImportRoute() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (isServer) return;
    const match = window.location.pathname.match(/^\/import\/recipe-api\/([^/?#]+)/);
    setId(match ? decodeURIComponent(match[1]) : '');
  }, []);
  return (
    <main id="stage" className="max-sm:min-h-screen">
      {id === null ? null
        : !id ? <div className="max-w-3xl mx-auto py-12 px-4">Missing recipe id.</div>
        : <RecipeApiImportPage id={id} />}
    </main>
  );
}
