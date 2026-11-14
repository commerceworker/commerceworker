import { createContext } from 'react';

/** Let the shared shell reserve space for whichever assistant serves the current surface. */
export const ContentAssistantVisibility = createContext<{
  open: boolean;
  setOpen(open: boolean): void;
}>({ open: false, setOpen: () => {} });
