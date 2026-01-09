import { ReactNode } from 'react';
import clsx from 'clsx';

interface SectionCardProps {
  title: string;
  description?: string;
  headerExtra?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SectionCard({ title, description, headerExtra, children, className }: SectionCardProps) {
  return (
    <section className={clsx('section-card', className)}>
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem' }}>
        <div style={{ flex: 1 }}>
          <h2>{title}</h2>
          {description && <p className="muted" style={{ marginTop: '0.25rem' }}>{description}</p>}
        </div>
        {headerExtra && <div>{headerExtra}</div>}
      </header>
      {children}
    </section>
  );
}
