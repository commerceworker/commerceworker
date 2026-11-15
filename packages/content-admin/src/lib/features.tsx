import { createContext, type ReactNode, useContext } from 'react';

/**
 * Surfaces that can be switched off. `assistant` (the assistant's column, its ⌘J toggle, and pages'
 * edits going through it) is on; off, pages make their edits straight through the API, as they also
 * do whenever the assistant can't be reached. `approvals` (the Approvals inbox) is on. Set per tree
 * with <FeaturesProvider> (tests, previews).
 */
export interface Features {
  readonly assistant: boolean;
  readonly approvals: boolean;
}

export const DEFAULT_FEATURES: Features = {
  assistant: true,
  approvals: true,
};

const Ctx = createContext<Features>(DEFAULT_FEATURES);

export function FeaturesProvider(props: { value: Partial<Features>; children: ReactNode }) {
  return (
    <Ctx.Provider value={{ ...DEFAULT_FEATURES, ...props.value }}>{props.children}</Ctx.Provider>
  );
}

export const useFeatures = () => useContext(Ctx);
