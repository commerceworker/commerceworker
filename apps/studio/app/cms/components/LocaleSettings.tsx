import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Badge } from '@commerceworker/ui/badge';
import { Button } from '@commerceworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@commerceworker/ui/catalog';
import { Segmented, SegmentedItem } from '@commerceworker/ui/segmented';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { Switch } from '@commerceworker/ui/switch';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Section } from '~/cms/components/page';
import { useClient } from '../lib/client-context';
import {
  apiErrorMessage,
  type ManagementClient,
  type SpaceConfig,
  type TextDirection,
} from '../lib/management';
import { useScopedQuery, useSpaceConfigQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The scope that changes locale settings, as `PUT …/locale-settings` checks it. */
const SPACE_ADMIN = 'space:admin';

type LocaleChange = { readonly delivered?: boolean; readonly direction?: TextDirection };

/** A row's two controls: together they outrun a phone's line, so they wrap rather than overflow. */
const CONTROLS = 'flex flex-wrap items-center gap-x-6 gap-y-2 sm:justify-end';

const DIRECTION_LABEL: Record<TextDirection, string> = {
  ltr: 'Left to right',
  rtl: 'Right to left',
};

/**
 * Settings → Locales: per locale, whether Delivery serves it and which way its text runs. One row
 * per locale: its code (the default one badged), what it falls back to, a Delivered switch and a
 * Direction choice. A change saves at once, except turning Delivered off, which asks first in
 * place: Delivery stops serving that locale everywhere at once. The default locale is always
 * delivered (every fallback ends there), so its switch is off-limits and says why. Changing any of
 * it needs space:admin; anyone else reads the settings and is told so.
 */
export function LocaleSettings(props: { client: ManagementClient }) {
  const { client } = props;
  const { conn } = useClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const config = useSpaceConfigQuery();
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), {
    silent: true,
  });
  // Unknown while access loads; if it can't be read, the controls stay usable and the api decides.
  const canEdit = access.data
    ? access.data.scopes.includes(SPACE_ADMIN)
    : access.isError
      ? true
      : undefined;
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const save = async (locale: string, change: LocaleChange) => {
    setSaving(locale);
    try {
      const next = await client.setLocaleSettings({ [locale]: change });
      // The settings are the space's, so every environment's cached config is stale now.
      queryClient.setQueryData([conn.space, conn.environment, 'space-config'], next);
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === conn.space && q.queryKey[2] === 'space-config',
      });
      toast.success(
        change.delivered === false
          ? `Delivery no longer serves ${locale}`
          : change.delivered === true
            ? `Delivery serves ${locale}`
            : `${locale} runs ${DIRECTION_LABEL[change.direction ?? 'ltr'].toLowerCase()}`,
      );
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const cfg = config.data;
  return (
    <Section
      title="Locales"
      description="Which locales Delivery serves, and which way each one’s text runs. Every environment of the space shares them."
      flush
    >
      {cfg === undefined && config.isError ? (
        <div className="px-5 pb-5">
          {/* A failed load is said as one, never as locales that look turned off. */}
          <Alert variant="destructive">
            <AlertTitle>The locale settings didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(config.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void config.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          {canEdit === false && (
            <div className="px-5">
              <Alert variant="warning">
                <AlertTitle>Read only</AlertTitle>
                <AlertDescription>
                  Changing locale settings is part of administering the space, so it takes the
                  space:admin permission. Ask a space administrator.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <div aria-busy={cfg === undefined || undefined}>
            {cfg === undefined && <LoadingStatus>Loading the locale settings…</LoadingStatus>}
            <Catalog aria-label="Locales">
              {cfg === undefined
                ? [0, 1].map((i) => (
                    <CatalogRow
                      key={i}
                      media={<CatalogTile />}
                      title={<SkeletonText width="4rem" />}
                      meta={<SkeletonText width="7rem" />}
                      aside={
                        <div className={CONTROLS}>
                          <CatalogFigure label="Delivered">
                            <SkeletonPill className="h-5 w-11" />
                          </CatalogFigure>
                          <SkeletonPill className="h-9 w-52" />
                        </div>
                      }
                    />
                  ))
                : cfg.locales.map((locale) => (
                    <LocaleRow
                      key={locale}
                      id={`${id}-${locale}`}
                      cfg={cfg}
                      locale={locale}
                      disabled={canEdit !== true || saving !== null}
                      confirming={confirming === locale}
                      onAskOff={() => setConfirming(locale)}
                      onCancelOff={() => setConfirming(null)}
                      onSave={(change) => {
                        setConfirming(null);
                        void save(locale, change);
                      }}
                    />
                  ))}
            </Catalog>
          </div>
        </>
      )}
    </Section>
  );
}

function LocaleRow(props: {
  id: string;
  cfg: SpaceConfig;
  locale: string;
  disabled: boolean;
  confirming: boolean;
  onAskOff: () => void;
  onCancelOff: () => void;
  onSave: (change: LocaleChange) => void;
}) {
  const { cfg, locale, id } = props;
  const isDefault = locale === cfg.defaultLocale;
  const settings = cfg.localeSettings?.[locale];
  const delivered = isDefault || settings?.delivered !== false;
  const direction = settings?.direction ?? 'ltr';
  // A missing fallback ends the chain at the default locale; the default itself falls back to none.
  const fallback = isDefault ? null : (cfg.fallbacks?.[locale] ?? cfg.defaultLocale);
  return (
    <Fragment>
      <CatalogRow
        // The language alone: a full tag such as zh-Hant-TW outruns the tile. The title has it whole.
        media={<CatalogTile aria-hidden="true">{locale.split('-')[0]}</CatalogTile>}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-medium font-mono">{locale}</span>
            {isDefault && <Badge variant="outline">Default</Badge>}
          </span>
        }
        meta={
          <span className="flex flex-wrap gap-x-2">
            {fallback ? (
              <span>
                Falls back to <span className="font-mono">{fallback}</span>
              </span>
            ) : (
              <span>No fallback</span>
            )}
            {isDefault && (
              <span id={`${id}-default`}>Always delivered: every fallback ends here.</span>
            )}
          </span>
        }
        aside={
          <div className={CONTROLS}>
            <CatalogFigure label="Delivered">
              <Switch
                checked={delivered}
                disabled={props.disabled || isDefault}
                aria-label={`Deliver ${locale}`}
                aria-describedby={isDefault ? `${id}-default` : undefined}
                onCheckedChange={(on) =>
                  on ? props.onSave({ delivered: true }) : props.onAskOff()
                }
              />
            </CatalogFigure>
            <Segmented
              aria-label={`Text direction of ${locale}`}
              value={direction}
              disabled={props.disabled}
              onValueChange={(v) => {
                if (v !== direction) props.onSave({ direction: v as TextDirection });
              }}
            >
              <SegmentedItem value="ltr">{DIRECTION_LABEL.ltr}</SegmentedItem>
              <SegmentedItem value="rtl">{DIRECTION_LABEL.rtl}</SegmentedItem>
            </Segmented>
          </div>
        }
      />
      {props.confirming && (
        <li>
          <InlineConfirm
            message={`Stop delivering ${locale}?`}
            note="Delivery stops serving it in every environment at once: a request naming it is not found, fallbacks skip it and the sitemap leaves it out. Editors still write and preview it."
            cancelLabel="Keep delivering"
            onCancel={props.onCancelOff}
          >
            <Button type="button" size="sm" onClick={() => props.onSave({ delivered: false })}>
              Stop delivering
            </Button>
          </InlineConfirm>
        </li>
      )}
    </Fragment>
  );
}
