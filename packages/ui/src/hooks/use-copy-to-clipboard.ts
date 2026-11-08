import * as React from 'react';

export function useCopyToClipboard(): {
  copy: (text: string) => Promise<boolean>;
  copied: boolean;
  reset: () => void;
} {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reset = React.useCallback(() => {
    setCopied(false);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const copy = React.useCallback(async (text: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setCopied(false);
      return false;
    }
  }, []);

  React.useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return { copy, copied, reset };
}
