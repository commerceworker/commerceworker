import { Link } from '@commerceworker/content-admin/router';
import { cn } from '@commerceworker/ui/lib/utils';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { SETTINGS_GROUPS } from './nav';

/**
 * Settings' section nav, grouped (Access, Automation, Extensions, Workspace).
 * From md a vertical list of links beside the section; below md a grouped
 * select above it, so a phone never scrolls a strip of a dozen tabs.
 */
export function SettingsNav(props: { section: string; onSection: (section: string) => void }) {
  const { section, onSection } = props;
  return (
    <>
      <div className="md:hidden">
        <Select value={section} onValueChange={onSection}>
          <SelectTrigger className="w-full" aria-label="Settings section">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_GROUPS.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.sections.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav aria-label="Settings sections" className="hidden md:block">
        <div className="sticky top-[calc(var(--shell-h)+1.5rem)] flex flex-col gap-5">
          {SETTINGS_GROUPS.map((g) => {
            const id = `settings-group-${g.label.toLowerCase()}`;
            return (
              <div key={g.label}>
                <div id={id} className="caption px-2.5 pb-1">
                  {g.label}
                </div>
                <ul aria-labelledby={id} className="flex flex-col gap-0.5">
                  {g.sections.map((s) => {
                    const current = s.id === section;
                    return (
                      <li key={s.id}>
                        <Link
                          to={`/settings/${s.id}`}
                          aria-current={current ? 'page' : undefined}
                          className={cn(
                            'relative flex items-center rounded-lg px-2.5 py-1.5 text-sm transition-[background-color,color] touch:min-h-11',
                            current
                              ? 'bg-accent font-medium text-accent-foreground current-item'
                              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                          )}
                        >
                          {s.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
    </>
  );
}
