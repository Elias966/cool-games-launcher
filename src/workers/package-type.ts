// Classifies a downloaded file by what the installer can do with it.
import { existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { detectArchiveKind } from './extract';
import { detectKind } from './exec-scan';

export type PackageType = 'archive' | 'linux-binary' | 'appimage' | 'windows-installer' | 'windows-exe' | 'unsupported';

export function packageType(path: string): PackageType {
  const name = basename(path).toLowerCase();
  if (detectArchiveKind(path)) return 'archive';
  if (name.endsWith('.appimage')) return 'appimage';
  if (name.endsWith('.msi')) return 'windows-installer';
  if (name.endsWith('.exe')) return /setup|install/i.test(name) ? 'windows-installer' : 'windows-exe';
  const kind = existsSync(path) ? detectKind(path, statSync(path).mode | 0o100) : null;
  if (kind === 'elf' || kind === 'script') return 'linux-binary';
  if (kind === 'appimage') return 'appimage';
  return 'unsupported';
}
