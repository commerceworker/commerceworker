import { Card, CardContent } from '@commerceworker/ui/card';
import { Ago } from '~/cms/components/ago';
import { When } from '~/cms/components/when';
import { type ActorDirectory, actorLabel } from '~/cms/lib/authorship';
import type { EntryAuthorship as Authorship } from '~/cms/lib/management';

/**
 * Who created the entry and who changed it last, at the top of the editor's details, in a card of
 * its own that never folds away: two lines are cheaper to read than a toggle. A writer reads as a
 * teammate's name, "You", or the kind of writer it was (an agent, a workflow, an API key), never
 * as an id; long names wrap rather than clip. An entry from before authorship was recorded says
 * so rather than guessing.
 */
export function EntryAuthorship(props: {
  readonly authorship: Authorship & { readonly updatedAt?: string | null };
  readonly directory?: ActorDirectory;
}) {
  const { authorship, directory } = props;
  return (
    <Card size="sm">
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Created by</dt>
          <dd className="min-w-0 break-words">
            {actorLabel(authorship.createdBy, directory)}
            {authorship.createdAt ? (
              <span className="text-muted-foreground">
                {' · '}
                <When at={authorship.createdAt} />
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Last edited by</dt>
          <dd className="min-w-0 break-words">
            {actorLabel(authorship.updatedBy, directory)}
            {authorship.updatedAt ? (
              <span className="text-muted-foreground">
                {' · '}
                <Ago at={authorship.updatedAt} />
              </span>
            ) : null}
          </dd>
        </dl>
      </CardContent>
    </Card>
  );
}
