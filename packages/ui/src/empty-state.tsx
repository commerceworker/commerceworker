import type { LucideIcon } from 'lucide-react';
import type * as React from 'react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './empty';
import { cn } from './lib/utils';

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  illustration?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  illustration: Illustration,
  action,
  className,
}: EmptyStateProps) {
  return (
    <Empty className={cn('bg-card p-10', className)}>
      <EmptyHeader>
        {Illustration ? (
          <Illustration className="mx-auto mb-2 h-36 w-48" />
        ) : (
          Icon && (
            <EmptyMedia variant="icon">
              <Icon className="size-5" strokeWidth={1.5} />
            </EmptyMedia>
          )
        )}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
