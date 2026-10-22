import { describe, expect, it } from 'vitest';
import { vkFromCode, vkIni, vkName } from '../src/shared/vk';

describe('shortcut keys as OptiScaler writes them', () => {
  it('maps physical keys to Windows key codes and back', () => {
    expect(vkFromCode('Insert')).toBe(0x2d);
    expect(vkFromCode('Home')).toBe(0x24);
    expect(vkFromCode('KeyM')).toBe(0x4d);
    expect(vkFromCode('Digit5')).toBe(0x35);
    expect(vkFromCode('F10')).toBe(0x79);
    expect(vkFromCode('Numpad7')).toBe(0x67);
    expect(vkFromCode('Backquote')).toBe(0xc0);
    expect(vkFromCode('Escape')).toBeNull();
    expect(vkFromCode('ShiftLeft')).toBeNull();
    expect(vkName(0x79)).toBe('F10');
    expect(vkName(0x2d)).toBe('Insert');
    expect(vkName(0x4d)).toBe('M');
    expect(vkIni(0x24)).toBe('0x24');
    expect(vkIni(0x8)).toBe('0x08');
  });
});
