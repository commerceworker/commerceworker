import { Ago } from '@commerceworker/content-admin/components/ago';
import {
  DiscardAsk,
  type DiscardGuard,
  useDiscardGuard,
} from '@commerceworker/content-admin/components/discard-guard';
import { LoadingStatus } from '@commerceworker/content-admin/components/loading';
import { RequiredMark } from '@commerceworker/content-admin/components/required-mark';
import { ResponsiveSheetContent } from '@commerceworker/content-admin/components/responsive-sheet';
import { ToneBadge } from '@commerceworker/content-admin/components/status';
import {
  ApiError,
  apiErrorMessage,
  isForbidden,
  type ManagementClient,
  type PluginSettingField,
  type PluginSettingsView,
  refusedSave,
  UNCONFIRMED_SAVE,
} from '@commerceworker/content-admin/lib/management';
import {
  defaultHint,
  type SecretDraft,
  type SettingDraft,
  type SettingsDraft,
  settingsDraft,
  settingsIssues,
  settingsPatch,
} from '@commerceworker/content-admin/lib/plugin-settings';
import { useToast } from '@commerceworker/content-admin/lib/toast';
import { Alert, AlertDescription, AlertTitle } from '@commerceworker/ui/alert';
import { Button } from '@commerceworker/ui/button';
import { DialogError } from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@commerceworker/ui/sheet';
import { SkeletonPill, SkeletonText } from '@commerceworker/ui/skeleton';
import { Switch } from '@commerceworker/ui/switch';
import { useCallback, useEffect, useRef, useState } from 'react';

type Refusal = { readonly kind: 'forbidden' | 'conflict' | 'error'; readonly message: string };

const FORBIDDEN =
  'Plugin settings are part of administering the space, so reading and changing them takes the space:admin permission. Ask a space administrator.';

/**
 * One plugin's settings, as a form drawn from what its manifest declares. A secret is write-only:
 * the form says whether one is set and offers Replace and Clear, and nothing it holds was ever read
 * from the server. Saving sends only what changed, against the version it loaded, so an edit made
 * on a stale form is refused (and offered a reload) rather than undoing someone else's.
 */
export function PluginSettingsSheet(props: {
  client: ManagementClient;
  plugin: { readonly id: string; readonly name: string };
  onOpenChange: (open: boolean) => void;
}) {
  const { client, plugin } = props;
  const [view, setView] = useState<PluginSettingsView>();
  const [loadError, setLoadError] = useState<unknown>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const guard = useDiscardGuard({ dirty, saving, onOpenChange: props.onOpenChange });

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      setView(await client.getPluginSettings(plugin.id));
    } catch (err) {
      setLoadError(err);
    }
  }, [client, plugin.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Sheet open onOpenChange={guard.onOpenChange}>
      <ResponsiveSheetContent className="sm:max-w-md" bodyClassName="gap-0">
        <SheetHeader className="gap-1 border-b pt-4 pb-3">
          <SheetTitle>{plugin.name} settings</SheetTitle>
          <SheetDescription className="text-xs">
            What the plugin reads when it runs. Secrets are write-only: once saved, they can be
            replaced or cleared, never read back.
          </SheetDescription>
        </SheetHeader>
        <div className="p-4">
          {loadError ? (
            <Alert variant={isForbidden(loadError) ? 'warning' : 'destructive'}>
              <AlertTitle>
                {isForbidden(loadError)
                  ? 'Your role can’t manage plugin settings'
                  : 'The settings didn’t load'}
              </AlertTitle>
              <AlertDescription>
                {isForbidden(loadError) ? FORBIDDEN : apiErrorMessage(loadError)}
                {!isForbidden(loadError) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void load()}
                  >
                    Retry
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          ) : !view ? (
            <div className="space-y-4">
              <LoadingStatus>Loading settings…</LoadingStatus>
              <SkeletonText lines={4} />
              <SkeletonPill />
            </div>
          ) : view.fields.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This plugin declares no settings. There is nothing to configure.
            </p>
          ) : (
            <SettingsForm
              // A new version (a save, or a reload after a conflict) starts a fresh draft.
              key={view.version}
              client={client}
              plugin={plugin}
              view={view}
              guard={guard}
              onDirty={setDirty}
              onSaving={setSaving}
              onSaved={(next) => {
                setView(next);
                props.onOpenChange(false);
              }}
              onReload={load}
            />
          )}
        </div>
      </ResponsiveSheetContent>
    </Sheet>
  );
}

function SettingsForm(props: {
  client: ManagementClient;
  plugin: { readonly id: string; readonly name: string };
  view: PluginSettingsView;
  guard: DiscardGuard;
  onDirty: (dirty: boolean) => void;
  onSaving: (saving: boolean) => void;
  onSaved: (view: PluginSettingsView) => void;
  onReload: () => Promise<void>;
}) {
  const { view, plugin } = props;
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsDraft(view));
  const [issues, setIssues] = useState<Readonly<Record<string, string>>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // A save with no answer to go on: it may have gone through, so it can't say it wasn't saved.
  const [unconfirmed, setUnconfirmed] = useState<string>();
  const [busy, setBusy] = useState(false);

  const patch = settingsPatch(view, draft);
  const dirty = Object.keys(patch).length > 0;
  const { onDirty, onSaving } = props;
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onSaving(busy);
    return () => onSaving(false);
  }, [busy, onSaving]);

  const set = (key: string, value: SettingDraft) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setIssues(({ [key]: _, ...rest }) => rest);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setRefusal(null);
    setUnconfirmed(undefined);
    try {
      const next = await props.client.setPluginSettings(plugin.id, {
        values: patch,
        expectedVersion: view.version,
      });
      setIssues({});
      toast.success(`${plugin.name}: settings saved`);
      props.onSaved(next);
    } catch (err) {
      props.guard.saveFailed(err);
      const { byKey, form } = settingsIssues(view.fields, err);
      setIssues(byKey);
      const first = view.fields.find((f) => byKey[f.key]);
      if (!refusedSave(err)) {
        setUnconfirmed(UNCONFIRMED_SAVE);
      } else if (isForbidden(err)) {
        setRefusal({ kind: 'forbidden', message: FORBIDDEN });
      } else if (err instanceof ApiError && err.status === 409) {
        setRefusal({
          kind: 'conflict',
          message: props.guard.unconfirmed
            ? 'These settings moved on after you opened them, perhaps by your own save that didn’t confirm. Reload to see what’s there; what you typed here is discarded.'
            : 'Someone saved these settings after you opened them. Reload to see their changes; what you typed here is discarded.',
        });
      } else if (!first || form.length > 0) {
        setRefusal({ kind: 'error', message: form[0] ?? apiErrorMessage(err) });
      }
      // Keyboard and screen reader users land on what needs fixing, not back at the button. Keys
      // are letters, digits and "_" (the manifest is checked), so they need no escaping here.
      if (first) {
        formRef.current?.querySelector<HTMLElement>(`[data-setting="${first.key}"]`)?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="space-y-5" onSubmit={(e) => void submit(e)} noValidate>
      {refusal && (
        <Alert variant={refusal.kind === 'forbidden' ? 'warning' : 'destructive'}>
          <AlertTitle>
            {refusal.kind === 'forbidden'
              ? 'Your role can’t change plugin settings'
              : refusal.kind === 'conflict'
                ? 'These settings changed'
                : props.guard.unconfirmed
                  ? 'This try was refused'
                  : 'The settings weren’t saved'}
          </AlertTitle>
          <AlertDescription>
            {refusal.message}
            {refusal.kind === 'conflict' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void props.onReload()}
              >
                Reload settings
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {view.fields.map((field) => (
        <SettingField
          key={field.key}
          field={field}
          idPrefix={`plugin-setting-${plugin.id}`}
          draft={draft[field.key]}
          isSet={view.secretsSet.includes(field.key)}
          issue={issues[field.key]}
          onChange={(value) => set(field.key, value)}
        />
      ))}

      {unconfirmed && <DialogError>{unconfirmed}</DialogError>}
      <SheetFooter className="-mx-4 -mb-4 sm:flex-wrap sm:items-center">
        {view.updatedAt && (
          <p className="text-muted-foreground text-xs sm:mr-auto">
            Last saved <Ago at={view.updatedAt} />
            {view.updatedBy ? ` by ${view.updatedBy}` : ''}
          </p>
        )}
        <DiscardAsk guard={props.guard} message={`Discard your changes to ${plugin.name}?`}>
          <Button type="submit" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </DiscardAsk>
      </SheetFooter>
    </form>
  );
}

/** One declared field: its label, the control its type calls for, its hint, and its refusal. */
function SettingField(props: {
  field: PluginSettingField;
  idPrefix: string;
  draft: SettingDraft | undefined;
  isSet: boolean;
  issue: string | undefined;
  onChange: (value: SettingDraft) => void;
}) {
  const { field, issue } = props;
  const id = `${props.idPrefix}-${field.key}`;
  const hint = [field.description, defaultHint(field)].filter(Boolean).join(' ');
  const describedBy =
    [issue ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  const control = {
    id,
    'data-setting': field.key,
    'aria-invalid': issue ? true : undefined,
    'aria-describedby': describedBy,
  } as const;

  const label = (
    <>
      {field.label}
      {field.required && field.default === undefined && <RequiredMark />}
    </>
  );
  const footnotes = (
    <>
      {hint && (
        <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {issue && (
        <p id={`${id}-error`} className="text-destructive text-xs">
          {issue}
        </p>
      )}
    </>
  );

  if (field.secret) {
    return (
      <SecretField
        field={field}
        id={id}
        label={label}
        draft={
          typeof props.draft === 'object' && props.draft !== null ? props.draft : { action: 'keep' }
        }
        isSet={props.isSet}
        control={control}
        onChange={props.onChange}
        footnotes={footnotes}
      />
    );
  }

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-3">
        <Switch
          {...control}
          checked={props.draft === true}
          onCheckedChange={(checked) => props.onChange(checked)}
        />
        <div className="space-y-0.5">
          <Label htmlFor={id}>{label}</Label>
          {footnotes}
        </div>
      </div>
    );
  }

  const text = typeof props.draft === 'string' ? props.draft : '';
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {field.type === 'select' ? (
        <NativeSelect
          {...control}
          wrapperClassName="w-full"
          value={text}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {/* Unset is a choice when nothing requires a value (a default then applies). */}
          <NativeSelectOption value="">
            {field.default !== undefined ? `Default (${String(field.default)})` : 'Not set'}
          </NativeSelectOption>
          {(field.options ?? []).map((option) => (
            <NativeSelectOption key={option} value={option}>
              {option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <Input
          {...control}
          value={text}
          onChange={(e) => props.onChange(e.target.value)}
          {...(field.type === 'number'
            ? { inputMode: 'decimal' as const, autoComplete: 'off' }
            : { maxLength: 4096, autoComplete: 'off' })}
        />
      )}
      {footnotes}
    </div>
  );
}

/**
 * A write-only field: whether a value is set, and Replace or Clear. The new value is typed into a
 * password input that starts empty; there is never an old value to show.
 */
function SecretField(props: {
  field: PluginSettingField;
  id: string;
  label: React.ReactNode;
  draft: SecretDraft;
  isSet: boolean;
  control: Record<string, unknown>;
  onChange: (value: SecretDraft) => void;
  footnotes: React.ReactNode;
}) {
  const { field, id, draft, isSet } = props;
  const actionsRef = useRef<HTMLDivElement>(null);
  // Focus follows the decision: into the new input on Replace, back to the buttons on Cancel/Undo.
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => {
    if (returnFocus && draft.action === 'keep') {
      actionsRef.current?.querySelector<HTMLElement>('button')?.focus();
      setReturnFocus(false);
    }
  }, [returnFocus, draft.action]);
  const keep = () => {
    props.onChange({ action: 'keep' });
    setReturnFocus(true);
  };

  const state = draft.action === 'clear' ? 'Cleared on save' : isSet ? 'Set' : 'Not set';

  return (
    <fieldset aria-labelledby={`${id}-label`} className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-2">
        {draft.action === 'replace' ? (
          <Label id={`${id}-label`} htmlFor={id}>
            {props.label}
          </Label>
        ) : (
          <span id={`${id}-label`} className="font-medium text-sm">
            {props.label}
          </span>
        )}
        <ToneBadge tone={draft.action === 'clear' ? 'wait' : 'idle'} label={state} />
      </div>
      {draft.action === 'replace' ? (
        <div className="flex gap-2">
          <Input
            {...props.control}
            type="password"
            // A new credential for the plugin, not the operator's own: keep password managers out.
            autoComplete="new-password"
            autoFocus
            maxLength={4096}
            value={draft.value}
            placeholder={isSet ? 'New value' : undefined}
            onChange={(e) => props.onChange({ action: 'replace', value: e.target.value })}
          />
          <Button type="button" variant="ghost" onClick={keep}>
            Cancel
          </Button>
        </div>
      ) : (
        <div ref={actionsRef} className="flex flex-wrap gap-2">
          {draft.action === 'clear' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Keep ${field.label}`}
              onClick={keep}
            >
              Undo
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-setting={field.key}
                aria-label={`${isSet ? 'Replace' : 'Set'} ${field.label}`}
                aria-invalid={props.control['aria-invalid'] as boolean | undefined}
                aria-describedby={props.control['aria-describedby'] as string | undefined}
                onClick={() => props.onChange({ action: 'replace', value: '' })}
              >
                {isSet ? 'Replace' : 'Set'}
              </Button>
              {isSet && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Clear ${field.label}`}
                  onClick={() => props.onChange({ action: 'clear' })}
                >
                  Clear
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {props.footnotes}
    </fieldset>
  );
}
