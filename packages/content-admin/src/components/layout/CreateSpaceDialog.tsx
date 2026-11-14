import { isReservedSpaceId, isSpaceId, normalizeSlug } from '@commerceworker/domain';
import { Button } from '@commerceworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@commerceworker/ui/dialog';
import { Input } from '@commerceworker/ui/input';
import { Label } from '@commerceworker/ui/label';
import { cn } from '@commerceworker/ui/lib/utils';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useClient } from '../../lib/client-context';
import type { SpaceStarter, SpaceStarterInfo, StarterInstallStarted } from '../../lib/management';
import { StarterInstallProgress } from './StarterInstallProgress';

/**
 * The starters every deployment has, shown until `GET /starters` answers (and if it can't): the
 * deployment adds the ones it offers beyond these, such as the enterprise demo.
 */
export const DEFAULT_STARTERS: readonly SpaceStarterInfo[] = [
  {
    id: 'sample',
    title: 'Start with sample content',
    description:
      'A content model covering every field type, a few dozen entries in each state, ' +
      'taxonomy, sample media and one open release. Edit or delete any of it.',
    background: false,
  },
  {
    id: 'empty',
    title: 'Empty space',
    description: 'No content types and no entries: model your content from scratch.',
    background: false,
  },
];

/** A background install the dialog is following, in the space it created. */
interface Following extends StarterInstallStarted {
  readonly spaceId: string;
  readonly environmentId: string;
  readonly title: string;
}

/** The space id a name suggests: the API's id rule, from a slug of the name. */
export function spaceIdFrom(name: string): string {
  return normalizeSlug(name).slice(0, 64).replace(/-+$/, '');
}

/**
 * Creates a space with a starter and switches to it. Deployment admins only (the api refuses
 * anyone else); opened from the space menu and from the CMS's no-spaces notice. The id follows the
 * name until it's edited, and is checked the way the API checks it. The starters are the
 * deployment's (`GET /starters`). One that installs in the background (the enterprise demo)
 * switches to the new space at once and turns the dialog into the install's progress, which can
 * be closed: the install keeps running on the server.
 */
export function CreateSpaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { client, spaces } = useClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState('en-US');
  const [starter, setStarter] = useState<SpaceStarter>('sample');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [following, setFollowing] = useState<Following | null>(null);
  const [installEnded, setInstallEnded] = useState(false);
  const uid = useId();
  const listed = useQuery({
    queryKey: ['starters'],
    queryFn: () => client.listStarters(),
    enabled: props.open,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const starters = listed.data?.length ? listed.data : DEFAULT_STARTERS;
  const chosen = starters.find((s) => s.id === starter);

  const spaceId = idEdited ? id.trim() : spaceIdFrom(name);
  const idProblem = !spaceId
    ? undefined
    : !isSpaceId(spaceId)
      ? 'Use up to 64 letters, digits, “.”, “_” or “-”, starting with a letter or digit.'
      : isReservedSpaceId(spaceId)
        ? 'This id is reserved. Choose another.'
        : spaces?.some((s) => s.id === spaceId)
          ? 'A space with this id already exists.'
          : undefined;
  const locale = defaultLocale.trim();
  const localeProblem =
    locale && (locale.length < 2 || locale.length > 35)
      ? 'A locale code is 2 to 35 characters, like en-US.'
      : undefined;

  const reset = () => {
    setName('');
    setId('');
    setIdEdited(false);
    setStarter('sample');
    setError(undefined);
    setFollowing(null);
    setInstallEnded(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !spaceId || !locale) {
      setError('A name, a space id and a default locale are required.');
      return;
    }
    if (idProblem || localeProblem) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await client.createSpace({
        spaceId,
        name: name.trim(),
        defaultLocale: locale,
        starter,
      });
      // The new space must be on the list before switching to it, or the scope falls back to
      // the first space on the (stale) list.
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });
      props.onCreated(spaceId);
      if (created.installing) {
        // The space is there; its content arrives over the next few minutes. Stay open on it.
        setFollowing({
          ...created.installing,
          spaceId,
          environmentId: 'main',
          title: chosen?.title ?? 'the starter',
        });
        return;
      }
      props.onOpenChange(false);
      reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /→ 403/.test(msg)
          ? 'Only a deployment admin can create a space.'
          : /→ 422/.test(msg) && starter === 'enterprise'
            ? 'This deployment doesn’t offer that starter. Choose another.'
            : starter !== 'empty'
              ? `Couldn’t finish creating the space. Try again: what was installed is kept, and nothing is added twice. (${msg})`
              : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (busy) return;
        props.onOpenChange(open);
        // Closed while following: the install goes on without it, and the next open is a new form.
        if (!open && following) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            {following
              ? `${following.spaceId} is created and open. Its content installs in the background, step by step.`
              : 'A space holds its own content model, entries, media and team, with a main environment to start.'}
          </DialogDescription>
        </DialogHeader>
        {following ? (
          <>
            <StarterInstallProgress
              spaceId={following.spaceId}
              environmentId={following.environmentId}
              install={following.install}
              steps={following.steps}
              title={following.title}
              // Every screen's data predates what the install wrote: read it again.
              onSettled={() => {
                setInstallEnded(true);
                void queryClient.invalidateQueries();
              }}
            />
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  props.onOpenChange(false);
                  reset();
                }}
              >
                {installEnded ? 'Done' : 'Close and keep installing'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-name`}>Name</Label>
              <Input
                id={`${uid}-name`}
                value={name}
                placeholder="Marketing site"
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-id`}>Space ID</Label>
                <Input
                  id={`${uid}-id`}
                  value={spaceId}
                  placeholder="marketing-site"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={idProblem ? true : undefined}
                  aria-describedby={`${uid}-id-hint`}
                  onChange={(e) => {
                    setIdEdited(true);
                    setId(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-locale`}>Default locale</Label>
                <Input
                  id={`${uid}-locale`}
                  value={defaultLocale}
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={localeProblem ? true : undefined}
                  onChange={(e) => setDefaultLocale(e.target.value)}
                />
              </div>
            </div>
            <p
              id={`${uid}-id-hint`}
              className={cn(
                'max-w-measure text-xs',
                idProblem || localeProblem ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {idProblem ??
                localeProblem ??
                'The id appears in API paths and can’t be changed later.'}
            </p>
            <fieldset className="space-y-2">
              <legend className="caption mb-2 text-muted-foreground">Start with</legend>
              {starters.map((choice) => (
                <label
                  key={choice.id}
                  className="flex cursor-pointer gap-3 rounded-xl bg-muted p-4 ring-foreground has-checked:ring-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
                >
                  <input
                    type="radio"
                    name={`${uid}-starter`}
                    value={choice.id}
                    checked={starter === choice.id}
                    onChange={() => setStarter(choice.id)}
                    className="mt-0.5 size-4 shrink-0 accent-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm">
                      {choice.title}
                      {choice.id === 'sample' && (
                        <span className="ml-2 text-muted-foreground text-xs font-normal">
                          Recommended
                        </span>
                      )}
                      {choice.background && (
                        <span className="ml-2 text-muted-foreground text-xs font-normal">
                          Installs in the background
                        </span>
                      )}
                    </span>
                    <span className="max-w-measure text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {error && <DialogError>{error}</DialogError>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => props.onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy
                  ? starter === 'sample'
                    ? 'Installing sample content…'
                    : 'Creating…'
                  : 'Create space'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
