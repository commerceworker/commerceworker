import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useHydrated } from './use-hydrated';

describe('useHydrated', () => {
  it('reports hydrated after mount (effect)', async () => {
    const { result } = renderHook(() => useHydrated());
    await waitFor(() => expect(result.current).toBe(true));
  });
});
