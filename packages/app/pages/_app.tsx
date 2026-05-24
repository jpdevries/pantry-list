import { useEffect, useState } from 'react';
import type { AppProps } from 'next/app';
import Nav from '@/components/Nav';
import { PreferBrowserChromeProvider, rawToUserPref, type PreferBrowserChromeUserPref } from '@pantry-host/shared/components/prefer-browser-chrome';
import OfflineBanner from '@/components/OfflineBanner';
import { KitchenProvider } from '@/lib/kitchen-context';
import Footer from '@pantry-host/shared/components/Footer';
import { flush } from '@/lib/offlineQueue';
import { registerFlush } from '@/lib/apiStatus';
import { initTheme } from '@pantry-host/shared/theme';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  // PREFER_BROWSER_CHROME — fetched on mount from /api/settings-read.
  // Tri-state: 'on' (explicit), 'off' (explicit), or undefined (no pref →
  // Provider falls back to touch-first auto-detect). The shared SettingsPage
  // uses formAction='/api/settings-write' which triggers a full page reload
  // on save, so this state is always fresh after a settings change without
  // explicit listener wiring.
  const [preferBrowserChrome, setPreferBrowserChrome] = useState<PreferBrowserChromeUserPref>(undefined);
  useEffect(() => {
    fetch('/api/settings-read')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { values?: Record<string, string | null> } | null) => {
        setPreferBrowserChrome(rawToUserPref(d?.values?.PREFER_BROWSER_CHROME));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Normalize scheme-prefixed URL variants (at:, http:, https:) to their
    // scheme-named route so route matching works. Some edges/hosts rewrite
    // "://" to "%3A//" or "%3A%2F%2F"; we handle all three shapes.
    {
      const p = window.location.pathname;
      const rewritten = p
        .replace(/^\/at%3A\/\/?/i, '/at/')
        .replace(/^\/at:\/\//, '/at/')
        .replace(/^\/https%3A(?:%2F%2F|\/\/?)/i, '/https/')
        .replace(/^\/https:\/\//i, '/https/')
        .replace(/^\/http%3A(?:%2F%2F|\/\/?)/i, '/http/')
        .replace(/^\/http:\/\//i, '/http/');
      if (rewritten !== p) {
        window.history.replaceState({}, '', rewritten + window.location.search + window.location.hash);
      }
    }

    if ('serviceWorker' in navigator) {
      const buildHash = document.querySelector<HTMLMetaElement>('meta[name="build-hash"]')?.content || 'dev';
      // Snapshot whether the page was already SW-controlled when we
      // loaded. Used below to distinguish a "first install" (no prior
      // controller — the page is already fresh, no reload needed) from
      // a real "new build claimed us" event (had a prior controller —
      // reload to pick up new HTML + JS bundles).
      const wasControlled = !!navigator.serviceWorker.controller;

      // `updateViaCache: 'none'` bypasses the browser HTTP cache when
      // checking for SW updates — so a newly-deployed sw.js is always
      // fetched fresh rather than served from the HTTP cache. Without
      // this, Rex's unset Cache-Control lets browsers heuristically
      // cache /sw.js for hours, preventing the SW from noticing that
      // the build hash changed on the server.
      navigator.serviceWorker
        .register(`/sw.js?v=${buildHash}`, { updateViaCache: 'none' })
        .catch(console.error);

      // When a new SW activates after a deploy, it posts a 'SW_UPDATED'
      // message. Reload so the page picks up the new HTML + JS bundles.
      // On homescreen PWAs there's no reload button, so this is the only
      // way to escape stale assets without the user force-quitting the app.
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'SW_UPDATED' && wasControlled) {
          window.location.reload();
        }
      });
    }
    initTheme();
    // Flush is triggered by API coming back online, not navigator.online —
    // so it works when returning home from the grocery store (5G → home wifi)
    registerFlush(flush);
    // Flush any mutations queued while offline on startup
    flush().catch(console.error);

    // TODO: Remove this workaround when Rex fixes SSR with React 19.
    // When SSR fails (prod mode), the browser can't resolve #hash anchors
    // against the empty document. Re-scroll to the hash target after hydration.
    if (window.location.hash) {
      const id = window.location.hash.slice(1);

      // Scroll behavior: respect prefers-reduced-motion (always instant).
      // Otherwise smooth-scroll the first 3 times to teach the user that
      // the main nav lives at the top of the page, not offscreen. After
      // 3 smooth scrolls, switch to instant permanently.
      const SCROLL_KEY = 'pantry-host:smooth-scroll-count';
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let behavior: ScrollBehavior = 'instant';
      if (!prefersReduced) {
        const count = parseInt(localStorage.getItem(SCROLL_KEY) ?? '0', 10);
        if (count < 3) {
          behavior = 'smooth';
          localStorage.setItem(SCROLL_KEY, String(count + 1));
        }
      }

      const scrollTo = (el: Element) => el.scrollIntoView({ behavior });
      const el = document.getElementById(id);
      if (el) {
        scrollTo(el);
      } else {
        // Element may not exist yet (data still loading). Retry briefly.
        const t = setTimeout(() => {
          const target = document.getElementById(id);
          if (target) scrollTo(target);
        }, 300);
        return () => clearTimeout(t);
      }
    }
  }, []);

  return (
    <PreferBrowserChromeProvider userPref={preferBrowserChrome}>{/* tri-state: 'on' | 'off' | undefined */}
      <KitchenProvider>
        <Nav />
        <OfflineBanner />
        <Component {...pageProps} />
        <Footer />
      </KitchenProvider>
    </PreferBrowserChromeProvider>
  );
}
