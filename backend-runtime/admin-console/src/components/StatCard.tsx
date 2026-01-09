import { ReactNode } from 'react';
import clsx from 'clsx';

interface StatCardProps {
  icon?: ReactNode;
  title: string;
  value: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  trend?: ReactNode;
  className?: string;
}

export function StatCard({ icon, title, value, subtitle, badge, trend, className }: StatCardProps) {
  return (
    <div className={clsx('stat-card', className)}>
      <div className="stat-card__header">
        <div className="stat-card__title-group">
          <span className="stat-card__title">{title}</span>
          {badge && <span className="stat-card__badge">{badge}</span>}
        </div>
        {icon && <div className="stat-card__icon">{icon}</div>}
      </div>
      <div className="stat-card__value">{value}</div>
      {subtitle && <div className="stat-card__subtitle">{subtitle}</div>}
      {trend && <div className="stat-card__trend">{trend}</div>}
    </div>
  );
}
