import {
  CommandPalette,
  openCommandPalette,
} from '@commerceworker/content-admin/components/layout/CommandPalette';
import { NewEntry } from '@commerceworker/content-admin/components/layout/NewEntry';
import { SpaceSwitcher } from '@commerceworker/content-admin/components/layout/SpaceSwitcher';
import { AssistantProvider, useAssistant } from '@commerceworker/content-admin/lib/assistant';
import { useClient } from '@commerceworker/content-admin/lib/client-context';
import { CmsProviders } from '@commerceworker/content-admin/providers';
import { ContentHost } from '@commerceworker/content-admin/router';
import { ContentPersonContext } from '@commerceworker/content-admin/shared/use-me';
import { Button } from '@commerceworker/ui/button';
import { MessageSquareText, Search } from 'lucide-react';
import { lazy, Suspense, useContext, useEffect, useState } from 'react';
import { Outlet, useLoaderData } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import { contentEnabled, contentPerson } from '~/lib/content.server';
import { ContentAssistantVisibility } from '~/lib/content-assistant';
import type { Route } from './+types/content-shell';

const AssistantPanel = lazy(() =>
  import('@commerceworker/content-admin/components/assistant/panel').then((m) => ({
    default: m.AssistantPanel,
  })),
);

export async function loader({ request }: Route.LoaderArgs) {
  if (!contentEnabled()) throw new Response('Not found', { status: 404 });
  const caller = await requireUser(request);
  const me = await contentPerson(caller);
  if (!me) throw new Response('Content access is disabled', { status: 403 });
  return { me };
}

export default function ContentShell() {
  const { me } = useLoaderData<typeof loader>();
  return (
    <ContentHost.Provider value={{ unified: true, apiPrefix: '/content-api' }}>
      <ContentPersonContext.Provider value={me}>
        <CmsProviders>
          <AssistantProvider>
            <ContentWorkspace />
          </AssistantProvider>
        </CmsProviders>
      </ContentPersonContext.Provider>
    </ContentHost.Provider>
  );
}

function ContentWorkspace() {
  const assistant = useAssistant();
  const { ready } = useClient();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'j'
      ) {
        event.preventDefault();
        if (assistant.open) assistant.setOpen(false);
        else assistant.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assistant.open, assistant.setOpen, assistant.focus]);
  const [wanted, setWanted] = useState(assistant.open);
  const { setOpen } = useContext(ContentAssistantVisibility);
  useEffect(() => {
    if (assistant.open || assistant.acts.length) setWanted(true);
  }, [assistant.open, assistant.acts.length]);
  useEffect(() => {
    setOpen(assistant.open);
    return () => setOpen(false);
  }, [assistant.open, setOpen]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-safe-4 py-2 lg:px-safe-6">
        {ready ? <SpaceSwitcher stacked /> : null}
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={!ready} onClick={openCommandPalette}>
            <Search aria-hidden="true" /> Search content
          </Button>
          {ready ? <NewEntry look="header" /> : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => assistant.setOpen(!assistant.open)}
            aria-keyshortcuts="Meta+J Control+J"
          >
            <MessageSquareText aria-hidden="true" /> Content assistant
          </Button>
        </div>
      </div>
      <CommandPalette />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
        {wanted ? (
          <Suspense fallback={null}>
            <AssistantPanel />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}
