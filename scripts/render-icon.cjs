// Writes the launcher's PNG icons from build/icon-source.png (1024 px, transparent corners).
//   npx electron scripts/render-icon.cjs
const { app, nativeImage } = require('electron');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(join(root, 'build/icon-source.png'));
  if (source.isEmpty()) throw new Error('build/icon-source.png is missing or unreadable');
  mkdirSync(join(root, 'build/icons'), { recursive: true });
  writeFileSync(join(root, 'build/icon.png'), source.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  for (const s of [512, 256, 128, 64, 48, 32, 16]) {
    writeFileSync(join(root, `build/icons/${s}x${s}.png`), source.resize({ width: s, height: s, quality: 'best' }).toPNG());
  }
  writeFileSync(join(root, 'src/renderer/assets/app-icon.png'), source.resize({ width: 96, height: 96, quality: 'best' }).toPNG());
  app.quit();
});
