import { describe, expect, it } from 'vitest';
import { dlss5Choice, dlss5On } from '../src/shared/dlss5';

describe('where DLSS 5 runs', () => {
  it('follows Settings unless the game chose', () => {
    expect(dlss5On({ dlss5: 'auto', neuralRendering: false }, true)).toBe(true);
    expect(dlss5On({ dlss5: 'auto', neuralRendering: false }, false)).toBe(false);
    expect(dlss5On({ dlss5: 'on', neuralRendering: false }, false)).toBe(true);
    expect(dlss5On({ dlss5: 'off', neuralRendering: true }, true)).toBe(false);
  });

  it('keeps the plain switch of games set up before the three-way choice', () => {
    expect(dlss5Choice({ neuralRendering: true })).toBe('on');
    expect(dlss5Choice({ dlss5: 'auto', neuralRendering: true })).toBe('on');
    expect(dlss5Choice({})).toBe('auto');
  });
});
