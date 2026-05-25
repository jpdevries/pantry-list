import { useEffect, useState } from 'react';

/** One-time dismiss flag in localStorage. Once true we never render the
 *  banner again on this browser, regardless of route or origin. */
const DISMISSED_KEY = 'pantry-host-welcomed';

/** Captured `beforeinstallprompt` event. Spec-defined but not in the TS
 *  DOM lib yet, so we type it loosely. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Platform = 'ios-safari' | 'android-chrome' | 'desktop-mac' | 'desktop-other' | 'other';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const isIOS = /iPhone|iPad|iPod/.test(ua) && !(window as { MSStream?: unknown }).MSStream;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  if (isIOS && isSafari) return 'ios-safari';
  if (/Android/.test(ua) && /Chrome/.test(ua)) return 'android-chrome';
  if (/Macintosh/.test(ua)) return 'desktop-mac';
  if (/Windows|Linux|CrOS/.test(ua)) return 'desktop-other';
  return 'other';
}

/** First-visit welcome banner shown only on the secure (HTTPS) origin —
 *  i.e. when the user is reaching the app over their Tailscale tunnel.
 *  On the LAN HTTP origin there's nothing useful to bookmark, so this
 *  banner stays hidden entirely.
 *
 *  Dismissal is permanent (localStorage). Both the X close button and
 *  the install action set the dismiss flag — the meaningful action
 *  doubles as the acknowledgement. */
export default function WelcomeBanner() {
  // Defer all client-only state until after mount so SSR is stable and
  // we don't flash the banner before the dismissed flag is read.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    setMounted(true);
    const dismissed = window.localStorage.getItem(DISMISSED_KEY) === 'true';
    const isSecureOrigin = window.location.protocol === 'https:';
    setVisible(!dismissed && isSecureOrigin);
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      dismiss();
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Private mode / quota — banner will reappear next visit but we
      // can't do much about it. Silent failure is fine.
    }
    setVisible(false);
  }

  async function handleInstall() {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    // Either accept or dismiss — both count as "user dealt with it."
    setPromptEvent(null);
    dismiss();
  }

  if (!mounted || !visible) return null;

  const platform = detectPlatform();

  return (
    <aside
      role="region"
      aria-label="Welcome to Pantry Host"
      className="mb-6 relative rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg-card)] px-5 py-4"
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss welcome message"
        className="absolute top-2 right-2 p-1 rounded text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-body)]"
      >
        <CloseIcon />
      </button>

      <h2 className="font-semibold text-[var(--color-text-primary)] mb-1 pr-8">
        Welcome to your pantry.
      </h2>
      <p className="text-sm text-[var(--color-text-secondary)] mb-3">
        You're on your secure URL. Save it so it's one tap away — from your phone, your laptop,
        anywhere.
      </p>

      {promptEvent ? (
        <button
          type="button"
          className="btn-primary"
          onClick={handleInstall}
        >
          Install Pantry Host
        </button>
      ) : (
        <PlatformHint platform={platform} />
      )}
    </aside>
  );
}

function PlatformHint({ platform }: { platform: Platform }) {
  if (platform === 'ios-safari') {
    return (
      <p className="text-sm text-[var(--color-text-primary)]">
        Tap the <ShareIcon /> <span className="font-semibold">Share</span> icon in Safari and choose{' '}
        <span className="font-semibold">Add to Home Screen</span>.
      </p>
    );
  }
  if (platform === 'android-chrome') {
    return (
      <p className="text-sm text-[var(--color-text-primary)]">
        Tap the menu (⋮) in Chrome and choose{' '}
        <span className="font-semibold">Add to Home screen</span>.
      </p>
    );
  }
  if (platform === 'desktop-mac') {
    return (
      <p className="text-sm text-[var(--color-text-primary)]">
        Press{' '}
        <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border-card)] bg-[var(--color-bg-body)] font-mono text-xs">
          ⌘ D
        </kbd>{' '}
        to bookmark this page.
      </p>
    );
  }
  if (platform === 'desktop-other') {
    return (
      <p className="text-sm text-[var(--color-text-primary)]">
        Press{' '}
        <kbd className="px-1.5 py-0.5 rounded border border-[var(--color-border-card)] bg-[var(--color-bg-body)] font-mono text-xs">
          Ctrl D
        </kbd>{' '}
        to bookmark this page.
      </p>
    );
  }
  return (
    <p className="text-sm text-[var(--color-text-primary)]">
      Bookmark this page in your browser so it's one tap away.
    </p>
  );
}

function ShareIcon() {
  return (
    <svg
      className="inline-block align-text-bottom"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
