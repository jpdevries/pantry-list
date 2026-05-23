import { useState, useEffect } from 'react';
import WikibooksImportPage from '@/components/pages/WikibooksImportPage';
import { isServer } from '@pantry-host/shared/env';

/** See pages/import/mealdb/[idMeal].tsx for why <main id="stage"> is
 *  rendered here synchronously. */
export default function WikibooksImportRoute() {
  const [slug, setSlug] = useState<string | null>(null);
  useEffect(() => {
    if (isServer) return;
    const match = window.location.pathname.match(/^\/import\/wikibooks\/([^/?#]+)/);
    setSlug(match ? decodeURIComponent(match[1]) : '');
  }, []);
  return (
    <main id="stage" className="max-sm:min-h-screen">
      {slug === null ? null
        : !slug ? <div className="max-w-3xl mx-auto py-12 px-4">Missing recipe slug.</div>
        : <WikibooksImportPage slug={slug} />}
    </main>
  );
}
