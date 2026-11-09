import { describe, expect, it } from 'vitest';
import { riskBranch, uncheckedRoute } from '../src';

describe('AI gates without the model', () => {
  it('scores risk against the threshold, and an unchecked score as high at least at it', () => {
    expect(riskBranch(80, 70, false)).toEqual({ branch: 'high', risk: 80 });
    expect(riskBranch(70, 70, false)).toEqual({ branch: 'high', risk: 70 });
    expect(riskBranch(20, 70, false)).toEqual({ branch: 'low', risk: 20 });
    expect(riskBranch(20, 70, true)).toEqual({ branch: 'high', risk: 70 });
    expect(riskBranch(95, 70, true)).toEqual({ branch: 'high', risk: 95 });
  });

  it("routes an unchecked order to needs_approval when the router has it, else the heuristic's route", () => {
    expect(uncheckedRoute(['auto_approve', 'needs_approval'], 'auto_approve')).toBe(
      'needs_approval',
    );
    expect(uncheckedRoute(['auto_approve', 'escalate'], 'auto_approve')).toBe('auto_approve');
  });
});
