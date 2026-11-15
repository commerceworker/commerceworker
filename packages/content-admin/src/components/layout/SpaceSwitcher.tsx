import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@commerceworker/ui/select';
import { useClient } from '../../lib/client-context';
import { useSpaceConfigQuery } from '../../lib/queries';
import { EnvironmentSwitcher } from './EnvironmentSwitcher';
import { SpaceMenu } from './SpaceMenu';

/**
 * Topbar controls for the active space / environment / locale: a space switcher,
 * an environment (branch) switcher, and a locale Select from the space's config, where a locale
 * Delivery doesn't serve says so ("Not delivered"): it is still written and previewed.
 */
export function SpaceSwitcher(props: { stacked?: boolean }) {
  // Nothing to switch until the scope is known (after hydration, once the spaces load).
  return useClient().ready ? <Switchers stacked={props.stacked} /> : null;
}

function Switchers(props: { stacked?: boolean }) {
  const { conn, updateConn } = useClient();
  // The query cache's config, so a change in Settings → Locales shows here at once.
  const cfg = useSpaceConfigQuery().data;
  const locales = cfg?.locales.length ? cfg.locales : [conn.locale];
  const undelivered = (loc: string) => cfg?.localeSettings?.[loc]?.delivered === false;

  // Ensure the current locale is always selectable even if it isn't in the config.
  const options = locales.includes(conn.locale) ? locales : [conn.locale, ...locales];

  return (
    <div
      className={props.stacked ? 'flex flex-wrap items-center gap-2' : 'flex items-center gap-2'}
    >
      <SpaceMenu />
      <EnvironmentSwitcher />
      <Select value={conn.locale} onValueChange={(locale) => updateConn({ locale })}>
        {/* Grows for "Not delivered", which the chosen value shows too. */}
        <SelectTrigger size="sm" className="w-auto min-w-28" aria-label="Locale">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((loc) => (
            <SelectItem key={loc} value={loc}>
              {loc}
              {undelivered(loc) && (
                <>
                  {' '}
                  <span className="text-muted-foreground text-xs">Not delivered</span>
                </>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
