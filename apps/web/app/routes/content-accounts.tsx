import { Button } from '@commerceworker/ui/button';
import { Field, FieldLabel } from '@commerceworker/ui/field';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Body, PageHeader, Section } from '@commerceworker/ui/page';
import { data, Form, useActionData, useLoaderData, useNavigation } from 'react-router';
import { StepUpField } from '~/components/step-up-field';
import { audit } from '~/lib/audit.server';
import { requireUser, stepUp, stepUpMethod } from '~/lib/auth.server';
import { contentEnabled } from '~/lib/content.server';
import { authStore, contentAuthStore, contentTeamStore, workspaceStore } from '~/lib/wire.server';
import type { Route } from './+types/content-accounts';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'admin');
  if (!contentEnabled()) throw new Response('Not found', { status: 404 });
  const [commerce, content, method] = await Promise.all([
    workspaceStore().team(),
    contentTeamStore()?.people(),
    stepUpMethod(me),
  ]);
  return {
    commerce: commerce.people.filter((p) => !p.disabledAt),
    content: (content ?? []).filter((p) => !p.disabledAt),
    method,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  const store = contentAuthStore();
  if (!contentEnabled() || !store) throw new Response('Not found', { status: 404 });
  const form = await request.formData();
  const str = (key: string) => String(form.get(key) ?? '');
  const failed = await stepUp(request, me, { code: str('code'), password: str('password') });
  if (failed) return data({ error: failed, ok: false }, { status: 403 });
  const [commerce, content] = await Promise.all([
    authStore().user(str('commerce')),
    store.user(str('content')),
  ]);
  if (!commerce || !content || commerce.disabledAt || content.disabledAt)
    return data({ error: 'Choose two active accounts.', ok: false }, { status: 400 });
  if (!(await store.linkCommerceSubject(content.id, `commerce:${commerce.id}`)))
    return data(
      {
        error: 'One of these accounts is already linked. Existing links cannot be replaced.',
        ok: false,
      },
      { status: 409 },
    );
  await audit(request, 'auth.content_account_linked', {
    actor: me,
    target: commerce.id,
    detail: { contentUserId: content.id },
  });
  return data({ ok: true, error: null });
}

export default function ContentAccounts() {
  const { commerce, content, method } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const pending = useNavigation().state !== 'idle';
  return (
    <>
      <PageHeader
        title="Content accounts"
        subtitle="Link an existing content identity to a commerce account."
      />
      <Body>
        <Section title="Preserve existing content access">
          <p className="mb-4 max-w-measure text-muted-foreground text-sm">
            The selected commerce account will use the content account’s existing space access,
            personal views and assistant history. Check both accounts belong to the same person. A
            link is permanent and does not change their commerce role.
          </p>
          <Form method="post" className="flex max-w-xl flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="commerce-account">Commerce account</FieldLabel>
              <NativeSelect id="commerce-account" name="commerce" required defaultValue="">
                <NativeSelectOption value="" disabled>
                  Choose an account
                </NativeSelectOption>
                {commerce.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name} ({p.email})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="content-account">Existing content account</FieldLabel>
              <NativeSelect id="content-account" name="content" required defaultValue="">
                <NativeSelectOption value="" disabled>
                  Choose an account
                </NativeSelectOption>
                {content.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id}>
                    {p.name} ({p.email})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <StepUpField method={method} next="/content/accounts" />
            {result?.error ? (
              <p role="alert" className="text-bad text-sm">
                {result.error}
              </p>
            ) : null}
            {result?.ok ? (
              <p role="status" className="text-sm">
                Accounts linked.
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={pending || !commerce.length || !content.length}
              className="self-start"
            >
              Link these accounts
            </Button>
          </Form>
        </Section>
      </Body>
    </>
  );
}
