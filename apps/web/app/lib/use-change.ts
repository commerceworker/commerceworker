import type { AssistantTool } from '@commerceworker/core';
import { useState } from 'react';
import { useRevalidator } from 'react-router';
import { type ActResult, useAssistant } from '~/lib/assistant';

/**
 * A change made through the assistant (`act`): its confirm card says what it does and the person
 * answers it there. `run` settles with what the tool returned, or null when the person declined or
 * it was refused (`error` then says why). A change that went through reloads the page's data.
 */
export function useChange() {
  const { act } = useAssistant();
  const { revalidate } = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (tool: AssistantTool, input: unknown) => {
    setBusy(true);
    setError(null);
    let result: ActResult | null = null;
    try {
      result = await act(tool, input);
      if (!('declined' in result)) revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
    return 'declined' in result ? null : result.output;
  };
  return { run, busy, error, clearError: () => setError(null) };
}
