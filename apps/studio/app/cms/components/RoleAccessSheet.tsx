import type { ContentTypeGrant } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import { Checkbox } from '@commerceworker/ui/checkbox';
import { DialogError } from '@commerceworker/ui/dialog';
import { Label } from '@commerceworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import {
  Sheet,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@commerceworker/ui/sheet';
import { useId, useState } from 'react';
import { DiscardAsk, GuardCancel, useDiscardGuard } from '~/cms/components/discard-guard';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import type { RoleSummary } from '../lib/management';
import {
  actionAvailable,
  actionNeeds,
  CONTENT_ACTION_LABELS,
  CONTENT_ACTIONS,
  contentTypeName,
  heldActions,
  sameGrants,
  setAction,
} from '../lib/role-grants';

/**
 * A role's content access, per content type: what it may do with each, as five actions. Write and
 * Publish bring Delete and Unpublish with them, and unticking either finer one withholds it, so a
 * role can write without deleting or publish without unpublishing. Field rules are kept as they are.
 * Closing with unsaved changes asks first, in place.
 */
export function RoleAccessSheet(props: {
  role: RoleSummary;
  contentTypes: readonly { readonly apiId: string; readonly name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (grants: readonly ContentTypeGrant[]) => Promise<void>;
}) {
  const id = useId();
  const [grants, setGrants] = useState<readonly ContentTypeGrant[]>(props.role.contentGrants);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !sameGrants(grants, props.role.contentGrants);
  const guard = useDiscardGuard({
    saving: busy,
    open: props.open,
    dirty,
    onOpenChange: props.onOpenChange,
  });
  const names = new Map(props.contentTypes.map((t) => [t.apiId, t.name]));
  const addable = ['*', ...props.contentTypes.map((t) => t.apiId)].filter(
    (apiId) => !grants.some((g) => g.contentTypeApiId === apiId),
  );

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSave(grants);
    } catch (err) {
      setError(guard.saveFailed(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={guard.onOpenChange}>
      <ResponsiveSheetContent className="w-full sm:max-w-lg" bodyClassName="gap-0">
        <SheetHeader className="gap-1 border-b pt-4 pb-3">
          <SheetTitle>Content access: {props.role.name}</SheetTitle>
          <SheetDescription className="text-xs">
            Write and Publish bring Delete and Unpublish with them; untick either to withhold it. An
            exact type wins over Every type.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 p-4" onSubmit={save}>
          {grants.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No content: someone with this role sees and changes no entries.
            </p>
          ) : null}
          {grants.map((grant, index) => {
            const held = heldActions(grant);
            const type = contentTypeName(grant.contentTypeApiId, names);
            return (
              <fieldset
                key={grant.contentTypeApiId}
                className="space-y-2 rounded-xl bg-secondary/40 p-3"
              >
                <legend className="float-left mb-2 w-full font-medium text-sm">{type}</legend>
                <div className="clear-both grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CONTENT_ACTIONS.map((action) => {
                    const available = actionAvailable(held, action);
                    const { label, hint } = CONTENT_ACTION_LABELS[action];
                    const hintId = `${id}-${index}-${action}`;
                    return (
                      <Label
                        key={action}
                        className="flex items-start gap-2 font-normal aria-disabled:opacity-60"
                        aria-disabled={!available}
                      >
                        <Checkbox
                          aria-label={`${label} ${type}`}
                          aria-describedby={hintId}
                          checked={held.has(action)}
                          disabled={!available}
                          onCheckedChange={(c) =>
                            setGrants(
                              grants.map((g, i) =>
                                i === index ? setAction(g, action, c === true) : g,
                              ),
                            )
                          }
                        />
                        <span className="grid gap-0.5">
                          <span className="text-sm">{label}</span>
                          {/* Disabled, it says what it needs rather than what it would do. */}
                          <span id={hintId} className="text-muted-foreground text-xs">
                            {available ? hint : actionNeeds(action)}
                          </span>
                        </span>
                      </Label>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs">
                    {grant.deniedFields?.length || grant.readOnlyFields?.length
                      ? `Field rules kept: ${grant.deniedFields?.length ?? 0} hidden, ${grant.readOnlyFields?.length ?? 0} read-only. `
                      : null}
                    {/* A withhold the boxes can't show, kept as it is. */}
                    {grant.deniedActions?.includes('unpublish') && !held.has('publish')
                      ? 'Unpublish stays withheld: live entries can’t be trashed.'
                      : null}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove access to ${type}`}
                    onClick={() => setGrants(grants.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              </fieldset>
            );
          })}
          {addable.length > 0 ? (
            <div className="flex items-center gap-2">
              <NativeSelect
                aria-label="Content type to add"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                <NativeSelectOption value="">Add a content type…</NativeSelectOption>
                {addable.map((apiId) => (
                  <NativeSelectOption key={apiId} value={apiId}>
                    {contentTypeName(apiId, names)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!adding}
                onClick={() => {
                  setGrants([...grants, { contentTypeApiId: adding, actions: ['read'] }]);
                  setAdding('');
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
          {error ? <DialogError>{error}</DialogError> : null}
          <SheetFooter className="-mx-4 -mb-4">
            <DiscardAsk
              guard={guard}
              message={`Discard your changes to ${props.role.name}’s access?`}
            >
              <GuardCancel guard={guard} />
              <Button type="submit" disabled={busy || !dirty}>
                Save access
              </Button>
            </DiscardAsk>
          </SheetFooter>
        </form>
      </ResponsiveSheetContent>
    </Sheet>
  );
}
