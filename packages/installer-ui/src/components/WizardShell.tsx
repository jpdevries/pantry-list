import type { ReactNode } from 'react';

interface Action {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface Props {
  /** 1-indexed. */
  stepIndex: number;
  totalSteps: number;
  title: string;
  children: ReactNode;
  back?: Action;
  skip?: Action;
  primary: Action;
}

export default function WizardShell({
  stepIndex,
  totalSteps,
  title,
  children,
  back,
  skip,
  primary,
}: Props) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header: progress dots + brand */}
      <header className="shrink-0 px-6 py-5 border-b border-[var(--color-border-card)] flex items-center justify-between gap-4">
        <div className="flex items-center gap-2" aria-label={`Step ${stepIndex} of ${totalSteps}`}>
          {Array.from({ length: totalSteps }, (_, i) => {
            const n = i + 1;
            const filled = n <= stepIndex;
            return (
              <span
                key={n}
                className="block h-1.5 w-8 rounded-full transition-colors"
                style={{ backgroundColor: filled ? 'var(--color-accent)' : 'var(--color-accent-subtle)' }}
                aria-hidden="true"
              />
            );
          })}
          <span className="ml-2 text-xs text-[var(--color-text-secondary)]">
            Step {stepIndex} of {totalSteps}
          </span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-[var(--color-text-primary)]">
          Pantry Host
        </span>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-y-auto px-6 py-10">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-3xl font-bold tracking-tight text-[var(--color-text-primary)] mb-6">
            {title}
          </h1>
          {children}
        </div>
      </main>

      {/* Footer button bar */}
      <footer className="shrink-0 px-6 py-4 border-t border-[var(--color-border-card)] bg-[var(--color-bg-card)]">
        <div className="mx-auto max-w-2xl flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            onClick={back?.onClick}
            disabled={!back || back.disabled}
            aria-label="Previous step"
          >
            Back
          </button>
          <div className="flex-1" />
          {skip && (
            <button
              type="button"
              className="btn-secondary"
              onClick={skip.onClick}
              disabled={skip.disabled}
            >
              {skip.label}
            </button>
          )}
          <button
            type="button"
            className="btn-primary"
            onClick={primary.onClick}
            disabled={primary.disabled}
          >
            {primary.label}
          </button>
        </div>
      </footer>
    </div>
  );
}
