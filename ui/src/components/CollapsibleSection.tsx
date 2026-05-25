import { useState } from 'react';
import type { ReactNode } from 'react';

type Props = {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
};

export function CollapsibleSection({ title, defaultOpen = true, children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rail-section">
      <div
        className="rail-h"
        style={{ cursor: 'pointer', marginBottom: open ? undefined : 0 }}
        onClick={() => setOpen((o) => !o)}
      >
        <h3>{title}</h3>
        <svg
            viewBox="0 0 10 6"
            width="10"
            height="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s', color: 'var(--ink-3)' }}
          >
            <path d="M1 1l4 4 4-4" />
          </svg>
      </div>
      {open && children}
    </section>
  );
}
