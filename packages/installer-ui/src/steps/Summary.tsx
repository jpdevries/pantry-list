import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import confetti from 'canvas-confetti';
import WizardShell from '@/components/WizardShell';
import { api, type IntegrationState, type SetupStatus } from '@/lib/api';

interface Props {
  /** Initial snapshot from App-level fetch. Summary re-fetches on mount
   *  to pick up any changes the user made in earlier steps; the prop is
   *  used as the optimistic first render so we don't flash a spinner. */
  tailscale: IntegrationState;
  bluesky: IntegrationState;
}

function describe(label: string, state: IntegrationState): { headline: string; sub?: string } {
  switch (state.state) {
    case 'connected':
      return { headline: `${label} · Connected`, sub: state.label };
    case 'connecting':
      return { headline: `${label} · In progress`, sub: 'Finish the Tailscale step to enable HTTPS' };
    case 'skipped':
      return { headline: `${label} · Skipped` };
    case 'unavailable':
      return { headline: `${label} · Unavailable`, sub: state.reason };
    default:
      return { headline: `${label} · Not configured` };
  }
}

export default function Summary({ tailscale: initialTailscale, bluesky: initialBluesky }: Props) {
  const navigate = useNavigate();
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tailscale, setTailscale] = useState<IntegrationState>(initialTailscale);
  const [bluesky, setBluesky] = useState<IntegrationState>(initialBluesky);

  // Re-fetch on mount so navigating Welcome → Tailscale (configure) →
  // Summary shows the fresh state, not the snapshot from App's initial
  // mount. App's fetch is the optimistic first paint; this is the truth.
  useEffect(() => {
    let cancelled = false;
    api
      .getSetupStatus()
      .then((s: SetupStatus) => {
        if (cancelled) return;
        setTailscale(s.integrations.tailscale);
        setBluesky(s.integrations.bluesky);
      })
      .catch(() => {
        // Initial snapshot stays in place if the refetch fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Celebration: short confetti burst on arrival. One-shot per mount; the
  // user wouldn't see it again on a back-then-forward, but that's fine —
  // celebrations should be a moment, not a Pavlovian loop. Also respect
  // prefers-reduced-motion since this is purely decorative.
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const end = Date.now() + 1200;
    const tick = () => {
      confetti({
        particleCount: 32,
        spread: 60,
        startVelocity: 38,
        origin: { x: 0.1, y: 0.65 },
        angle: 60,
      });
      confetti({
        particleCount: 32,
        spread: 60,
        startVelocity: 38,
        origin: { x: 0.9, y: 0.65 },
        angle: 120,
      });
      if (Date.now() < end) requestAnimationFrame(tick);
    };
    tick();
  }, []);

  async function finish() {
    setFinishing(true);
    setError(null);
    try {
      await api.finishSetup();
      window.location.href = '/';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to finish setup');
      setFinishing(false);
    }
  }

  const rows = [
    { key: 'tailscale', label: 'Remote access', ...describe('Remote access', tailscale) },
    { key: 'bluesky', label: 'Bluesky sharing', ...describe('Bluesky sharing', bluesky) },
  ];

  return (
    <WizardShell
      stepIndex={4}
      totalSteps={4}
      title="Your pantry is ready."
      back={{ label: 'Back', onClick: () => navigate('/bluesky') }}
      primary={{ label: finishing ? 'Opening…' : 'Open Pantry Host', onClick: finish, disabled: finishing }}
    >
      <p className="text-lg text-[var(--color-text-secondary)] mb-6">
        Here's what you set up. You can change any of this later in Settings.
      </p>
      <ul className="divide-y divide-[var(--color-border-card)] border border-[var(--color-border-card)] rounded-lg overflow-hidden">
        {rows.map((row) => (
          <li key={row.key} className="px-5 py-4 bg-[var(--color-bg-card)]">
            <p className="font-medium text-[var(--color-text-primary)]">{row.headline}</p>
            {row.sub && (
              <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{row.sub}</p>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-danger,#dc2626)]">
          {error}
        </p>
      )}
    </WizardShell>
  );
}
