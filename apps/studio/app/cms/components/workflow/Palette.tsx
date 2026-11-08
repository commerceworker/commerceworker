/**
 * Node palette, by category: drag onto the canvas with a mouse or trackpad, or click, tap or press
 * Enter to add after the selection.
 * Built-in nodes only (plugin node groups are deferred), and dragging is offered only to a
 * fine pointer (on touch, iPadOS drag is unreliable, so a tap adds).
 */

import {
  CATEGORY_LABELS,
  NODE_SPECS,
  type NodeCategory,
  type NodeSpec,
} from '@commerceworker/domain';
import { Input } from '@commerceworker/ui/input';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@commerceworker/ui/item';
import { useId, useState } from 'react';
import { useFinePointer } from '~/cms/lib/shortcuts';
import { DRAG_TYPE } from './graph';
import { CATEGORY_COLOR, NodeIcon } from './NodeIcon';

export function Palette({ onPick }: { onPick: (type: string) => void }) {
  const [q, setQ] = useState('');
  const fine = useFinePointer();
  const baseId = useId();
  const needle = q.toLowerCase();
  const cats = Object.keys(CATEGORY_LABELS) as NodeCategory[];
  const matches = (s: NodeSpec) =>
    !needle || `${s.label} ${s.description} ${s.type}`.toLowerCase().includes(needle);
  const sections = cats.map((cat) => ({
    key: cat,
    title: CATEGORY_LABELS[cat],
    items: (NODE_SPECS as readonly NodeSpec[]).filter((s) => s.category === cat && matches(s)),
  }));
  return (
    <nav aria-label="Steps" className="flex h-full min-h-0 flex-col">
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search steps"
        aria-label="Search steps"
        className="h-8 text-sm"
      />
      {/* Relative, so the rows' absolutely placed sr-only labels scroll here, not the page. */}
      <div className="relative mt-3 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {sections.map(({ key, title, items }) => {
          if (!items.length) return null;
          return (
            <section key={key} aria-labelledby={`${baseId}-${key}`}>
              <h2 id={`${baseId}-${key}`} className="caption mb-1.5 px-1">
                {title}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {items.map((s) => {
                  return (
                    <li key={s.type}>
                      <Item
                        asChild
                        size="xs"
                        className="cursor-grab flex-nowrap items-start gap-2 px-2 py-1.5 text-left hover:border-border hover:bg-muted/60 active:cursor-grabbing touch:cursor-default touch:py-2.5"
                      >
                        <button
                          type="button"
                          draggable={fine}
                          onDragStart={(e) => {
                            e.dataTransfer.setData(DRAG_TYPE, s.type);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                          onClick={() => onPick(s.type)}
                          title={s.description}
                        >
                          <ItemMedia>
                            <NodeIcon
                              name={s.icon}
                              className="size-3.5 shrink-0"
                              style={{ color: CATEGORY_COLOR[s.category] }}
                            />
                          </ItemMedia>
                          <ItemContent className="min-w-0 gap-0">
                            <ItemTitle className="font-normal text-ui">
                              {/* Named by what it shows, so a voice command can say it. */}
                              <span className="sr-only">Add</span> {s.label}
                            </ItemTitle>
                            <ItemDescription className="line-clamp-2 text-xs">
                              {s.description}
                            </ItemDescription>
                          </ItemContent>
                        </button>
                      </Item>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
