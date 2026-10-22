// Windows virtual-key codes, which OptiScaler's shortcut keys are written in,
// from a browser KeyboardEvent.code (the physical key, whatever the layout).
const NAMED: Record<string, [number, string]> = {
  Insert: [0x2d, 'Insert'], Delete: [0x2e, 'Delete'], Home: [0x24, 'Home'], End: [0x23, 'End'],
  PageUp: [0x21, 'Page Up'], PageDown: [0x22, 'Page Down'], Pause: [0x13, 'Pause'], ScrollLock: [0x91, 'Scroll Lock'],
  PrintScreen: [0x2c, 'Print Screen'], Tab: [0x09, 'Tab'], Backspace: [0x08, 'Backspace'], Enter: [0x0d, 'Enter'], Space: [0x20, 'Space'],
  ArrowUp: [0x26, '↑'], ArrowDown: [0x28, '↓'], ArrowLeft: [0x25, '←'], ArrowRight: [0x27, '→'],
  Backquote: [0xc0, '`'], Minus: [0xbd, '-'], Equal: [0xbb, '='], BracketLeft: [0xdb, '['], BracketRight: [0xdd, ']'],
  Backslash: [0xdc, '\\'], Semicolon: [0xba, ';'], Quote: [0xde, "'"], Comma: [0xbc, ','], Period: [0xbe, '.'], Slash: [0xbf, '/'],
  NumpadAdd: [0x6b, 'Num +'], NumpadSubtract: [0x6d, 'Num -'], NumpadMultiply: [0x6a, 'Num *'], NumpadDivide: [0x6f, 'Num /'], NumpadDecimal: [0x6e, 'Num .'],
};

/** The virtual-key code for a KeyboardEvent.code; null for keys games would not see on their own (Escape, modifiers). */
export function vkFromCode(code: string): number | null {
  if (NAMED[code]) return NAMED[code][0];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Digit(\d)$/.exec(code);
  if (m) return 0x30 + Number(m[1]);
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x6f + Number(m[1]);
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 0x60 + Number(m[1]);
  return null;
}

/** A readable name for a virtual-key code. */
export function vkName(vk: number): string {
  for (const [code, name] of Object.values(NAMED)) if (code === vk) return name;
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
  if (vk >= 0x60 && vk <= 0x69) return `Num ${vk - 0x60}`;
  return `0x${vk.toString(16).toUpperCase()}`;
}

/** As OptiScaler.ini writes it: 0x2D. */
export const vkIni = (vk: number) => `0x${vk.toString(16).toUpperCase().padStart(2, '0')}`;
