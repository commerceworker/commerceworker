/**
 * The deployment's first space, set up with Coworker: setup's last step, and where `/` sends a
 * deployment admin while there is no space (so it follows two-factor setup too). The admin says
 * what the space will hold; Coworker proposes a name, an id and a starter on a card, and nothing is
 * created until they confirm it. Then they land in the space with Coworker open on what to try
 * next. The form (the New space dialog) is always one press away, and is the whole step when the
 * assistant is off; skipping goes to the overview, where the CMS's own no-space prompt waits.
 *
 * Signed in (the shell's loader), drawn bare (`handle.bare`): no sidebar or header yet.
 */

import { CoworkerConversation } from '@commerceworker/content-admin/components/assistant/panel';
import { CreateSpaceDialog } from '@commerceworker/content-admin/components/layout/CreateSpaceDialog';
import { useAssistant } from '@commerceworker/content-admin/lib/assistant';
import { useClient, useScopeState } from '@commerceworker/content-admin/lib/client-context';
import { Button } from '@commerceworker/ui/button';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Mark } from '~/components/mark';
import { useCan, useMe } from '~/lib/use-me';

export const handle = { bare: true };

export const meta = () => [{ title: 'Your first space · CommerceWorker' }];

export default function SetupSpace() {
  const navigate = useNavigate();
  const me = useMe();
  const admin = useCan('admin');
  const state = useScopeState();
  const { updateConn } = useClient();
  const assistant = useAssistant();
  const [form, setForm] = useState(false);
  const heading = useId();
  // Set once a space is made here: the page then leaves on its own terms, not because one exists.
  const created = useRef<string | null>(null);

  // Nothing to set up here for anyone else, or once a space exists (it was made somewhere else).
  useEffect(() => {
    if (created.current) return;
    if ((me && !admin) || state === 'ready') navigate('/dashboard', { replace: true });
  }, [me, admin, state, navigate]);

  const toOverview = () => navigate('/dashboard', { replace: true });

  return (
    <main className="grid min-h-dvh content-start justify-items-center bg-background px-4 pt-[8vh] pb-10 max-sm:pt-6">
      <div className="w-full max-w-xl">
        <Mark className="size-7 text-brand" />
        <h1 className="mt-4 font-semibold text-2xl tracking-title">Your first space</h1>
        <p className="mt-1 max-w-measure text-muted-foreground text-sm">
          A space holds a content model, its entries and media, and the team that works on them.
        </p>

        {assistant.enabled ? (
          // On a phone the page scrolls and the card grows with the conversation, so the composer
          // is never held under the on-screen keyboard; wider, the card keeps its own scroll.
          <section
            aria-labelledby={heading}
            className="card mt-6 flex min-h-80 flex-col overflow-hidden sm:h-[min(32rem,calc(100dvh-18rem))]"
          >
            <h2 id={heading} className="sr-only">
              Set up with Coworker
            </h2>
            <CoworkerConversation
              // The conversation has already switched to the space; open Coworker beside it.
              onCreated={(id) => {
                created.current = id;
                assistant.setOpen(true);
                toOverview();
              }}
            />
          </section>
        ) : (
          <section aria-labelledby={heading} className="card mt-6 px-5 py-4">
            <h2 id={heading} className="section-title">
              Name it and choose how it starts
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              Start with sample content to see every part of the CMS at work, or with an empty space
              to model your own.
            </p>
            <Button className="mt-4" onClick={() => setForm(true)}>
              Create a space
            </Button>
          </section>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Button asChild variant="link" size="sm" className="px-0 text-muted-foreground">
            <Link to="/dashboard" replace>
              Skip for now
            </Link>
          </Button>
          {assistant.enabled ? (
            <Button variant="link" size="sm" className="px-0" onClick={() => setForm(true)}>
              Fill in a form instead
            </Button>
          ) : null}
        </div>
      </div>
      <CreateSpaceDialog
        open={form}
        onOpenChange={(open) => {
          setForm(open);
          // Leaves once the dialog is done: a starter that installs in the background keeps it
          // open on its progress until it is closed.
          if (!open && created.current) toOverview();
        }}
        onCreated={(id) => {
          created.current = id;
          updateConn({ space: id, environment: 'main' });
        }}
      />
    </main>
  );
}
