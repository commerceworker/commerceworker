import type * as React from 'react';
import { cn } from './lib/utils';
import { Tabs, TabsList, TabsTrigger } from './tabs';

export interface PageTabItem {
  label: string;
  value: string;
}

export interface PageTabsProps {
  tabs: PageTabItem[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
  tabsListClassName?: string;
  /** Tab panels (`TabsContent` components) rendered inside the same `Tabs` root */
  children?: React.ReactNode;
}

/** Router-agnostic tabs: wire `value` / `onValueChange` to your router (e.g. TanStack Router `navigate`). */
export function PageTabs({
  tabs,
  value,
  onValueChange,
  className,
  tabsListClassName,
  children,
}: PageTabsProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className={className}>
      <TabsList
        variant="default"
        className={cn(
          'mb-6 h-auto min-w-0 w-full justify-stretch sm:w-fit sm:justify-start group-data-horizontal/tabs:h-auto',
          tabsListClassName,
        )}
      >
        {tabs.map((tab) => (
          // Colours are owned by TabsTrigger so the active pill stays inverted.
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="min-h-9 flex-1 py-2 shadow-none sm:flex-none sm:min-w-0"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}
