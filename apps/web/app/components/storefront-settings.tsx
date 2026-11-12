import type { StorefrontSettings } from '@commerceworker/core';
import { Button } from '@commerceworker/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@commerceworker/ui/field';
import { NativeSelect, NativeSelectOption } from '@commerceworker/ui/native-select';
import { Section } from '@commerceworker/ui/page';
import { useState } from 'react';
import { useRevalidator } from 'react-router';
import { useAssistant } from '~/lib/assistant';

/** The flow the checkout is priced by is agentic checkout's, unless one is chosen. */
const SAME = '';

/** What a save sends: the form's choices as the tool takes them. */
export function storefrontInput(form: {
  enabled: boolean;
  flowId: string;
  editLines: boolean;
}): StorefrontSettings {
  return {
    checkout: {
      enabled: form.enabled,
      checkoutFlowId: form.flowId === SAME ? null : form.flowId,
      editLines: form.editLines,
    },
  };
}

/** What saving came to: saved, declined on its card (nothing changed), or refused with why (nothing changed). */
export async function saveStorefrontSettings(
  act: (tool: 'set_storefront_settings', input: unknown) => Promise<object>,
  form: { enabled: boolean; flowId: string; editLines: boolean },
): Promise<{ saved: true } | { saved: false; error?: string }> {
  try {
    const r = await act('set_storefront_settings', storefrontInput(form));
    return 'declined' in r ? { saved: false } : { saved: true };
  } catch (e) {
    return { saved: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Hosted checkout, the page a buyer pays on at the storefront: whether it is on, the flow that
 * prices it and whether buyers may change the lines. Saved through the assistant, as the other
 * workspace settings are: its card says what changes, and refuses a flow that can't take a card.
 */
export function StorefrontSettingsForm({
  settings,
  flows,
}: {
  settings: StorefrontSettings;
  flows: { id: string; name: string }[];
}) {
  const saved = settings.checkout;
  const [enabled, setEnabled] = useState(saved.enabled);
  const [flowId, setFlowId] = useState(saved.checkoutFlowId ?? SAME);
  const [editLines, setEditLines] = useState(saved.editLines);
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A flow saved earlier that is no longer published stays visible, marked, rather than showing as another.
  const missing = flowId !== SAME && !flows.some((f) => f.id === flowId) ? flowId : null;
  const changed =
    enabled !== saved.enabled ||
    flowId !== (saved.checkoutFlowId ?? SAME) ||
    editLines !== saved.editLines;
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await saveStorefrontSettings(act, { enabled, flowId, editLines });
    if (r.saved) revalidate();
    else if (r.error) setError(r.error);
    setBusy(false);
  };
  return (
    <Section
      title="Hosted checkout"
      description="A page on your storefront where a buyer finishes a checkout you made for them over the API."
    >
      <div className="max-w-xl">
        <FieldGroup className="gap-5">
          <Field orientation="horizontal">
            <input
              id="hosted-enabled"
              type="checkbox"
              aria-describedby="hosted-enabled-hint"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <FieldContent>
              <FieldLabel htmlFor="hosted-enabled" className="font-normal">
                Turn on hosted checkout
              </FieldLabel>
              <FieldDescription id="hosted-enabled-hint" className="text-xs">
                When it is off, the links you made stop working and nobody can open a checkout page.
                Outside test mode the page takes details only; buyers can’t pay on it yet.
              </FieldDescription>
            </FieldContent>
          </Field>
          <Field>
            <FieldLabel htmlFor="hosted-flow">Checkout flow</FieldLabel>
            <NativeSelect
              id="hosted-flow"
              value={flowId}
              aria-describedby="hosted-flow-hint"
              onChange={(e) => setFlowId(e.target.value)}
              className="h-9 w-full"
            >
              <NativeSelectOption value={SAME}>The flow agentic checkout uses</NativeSelectOption>
              {missing ? (
                <NativeSelectOption value={missing}>{missing} (not published)</NativeSelectOption>
              ) : null}
              {flows.map((f) => (
                <NativeSelectOption key={f.id} value={f.id}>
                  {f.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription id="hosted-flow-hint" className="text-xs">
              Prices every hosted checkout and places its order. It must authorize a card payment;
              turning checkout on is refused for a flow that doesn’t.
            </FieldDescription>
          </Field>
          <Field orientation="horizontal">
            <input
              id="hosted-edit-lines"
              type="checkbox"
              aria-describedby="hosted-edit-lines-hint"
              checked={editLines}
              onChange={(e) => setEditLines(e.target.checked)}
            />
            <FieldContent>
              <FieldLabel htmlFor="hosted-edit-lines" className="font-normal">
                Let buyers change the lines
              </FieldLabel>
              <FieldDescription id="hosted-edit-lines-hint" className="text-xs">
                Off, a buyer changes their details, shipping and codes, and only you change what is
                in the checkout. A buyer never sets a price.
              </FieldDescription>
            </FieldContent>
          </Field>
          {error ? <FieldError>{error}</FieldError> : null}
          <div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !changed}
              onClick={() => void save()}
            >
              {busy ? 'Confirm it in the assistant' : 'Save'}
            </Button>
          </div>
        </FieldGroup>
      </div>
    </Section>
  );
}
