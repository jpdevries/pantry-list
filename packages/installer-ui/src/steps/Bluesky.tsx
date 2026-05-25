import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import WizardShell from '@/components/WizardShell';
import { api, type BlueskyState } from '@/lib/api';

export default function Bluesky() {
  const navigate = useNavigate();
  const [state, setState] = useState<BlueskyState | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBlueskyStatus()
      .then((s) => {
        if (cancelled) return;
        setState(s);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to read Bluesky status');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.connectBluesky(handle.trim());
      setState(s);
      setHandle('');
    } catch (err) {
      // The backend returns 400 with `error` in the body when the handle
      // can't be resolved. The shared `request` helper throws a generic
      // "path → status" message; for now we surface a friendlier line
      // since "could not resolve" is by far the most common failure.
      setError(
        err instanceof Error && err.message.includes('400')
          ? `We couldn't find @${handle.trim().replace(/^@/, '')} on Bluesky. Double-check the spelling?`
          : err instanceof Error
            ? err.message
            : 'Failed to connect Bluesky',
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.disconnectBluesky();
      setState(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  const back = { label: 'Back', onClick: () => navigate('/tailscale') };
  const next = { label: 'Continue', onClick: () => navigate('/summary') };

  if (!state) {
    return (
      <WizardShell
        stepIndex={3}
        totalSteps={4}
        title="Bluesky sharing"
        back={back}
        primary={{ label: 'Continue', onClick: next.onClick, disabled: true }}
      >
        <p className="text-[var(--color-text-secondary)]">Checking…</p>
      </WizardShell>
    );
  }

  return (
    <WizardShell
      stepIndex={3}
      totalSteps={4}
      title="Bluesky sharing"
      back={back}
      skip={state.state === 'configured' ? undefined : { label: 'Skip for now', onClick: next.onClick }}
      primary={{ label: busy ? 'Working…' : 'Continue', onClick: next.onClick, disabled: busy }}
    >
      <p className="text-lg text-[var(--color-text-secondary)] mb-6">
        Bluesky is an open social network. Connect your handle to discover recipes from people
        you follow and, soon, publish your own recipes back to your account. This is optional —
        the rest of Pantry Host works without it.
      </p>

      {state.state === 'not_configured' && (
        <Panel>
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Connect your Bluesky handle
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            We'll verify the handle exists — nothing is published and no password is needed.
            Don't have an account yet?{' '}
            <a
              href="https://bsky.app"
              target="_blank"
              rel="noreferrer"
              className="underline text-[var(--color-accent)]"
            >
              bsky.app
            </a>{' '}
            is free to join.
          </p>
          <form onSubmit={connect} className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
            <label className="sr-only" htmlFor="bsky-handle">
              Bluesky handle
            </label>
            <input
              id="bsky-handle"
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="you.bsky.social"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              className="flex-1 rounded border border-[var(--color-border-card)] bg-[var(--color-bg-body)] px-3 py-2 text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !handle.trim()}
            >
              {busy ? 'Verifying…' : 'Connect'}
            </button>
          </form>
        </Panel>
      )}

      {state.state === 'configured' && (
        <Panel tone="success">
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Connected as <span className="font-mono text-sm">@{state.handle}</span>
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4 break-all">
            <span className="font-mono">{state.did}</span>
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={disconnect}
            disabled={busy}
          >
            {busy ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </Panel>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-danger,#dc2626)]">
          {error}
        </p>
      )}
    </WizardShell>
  );
}

function Panel({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'info' | 'success';
}) {
  const border =
    tone === 'success'
      ? 'border-[var(--color-accent)]'
      : 'border-[var(--color-border-card)]';
  return (
    <div
      className={`rounded-lg border ${border} bg-[var(--color-bg-card)] px-5 py-4`}
    >
      {children}
    </div>
  );
}
