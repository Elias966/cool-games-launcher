// Renders build/icon.svg to PNG icons with Electron's offscreen renderer.
//   npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, 'build/icon.svg'), 'utf8');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  mkdirSync(join(root, 'build/icons'), { recursive: true });
  const size = 512;
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 200));
  const img = (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).resize({ width: size, height: size });
  writeFileSync(join(root, 'build/icon.png'), img.toPNG());
  // Smaller sizes are downscaled from the 512 px render.
  for (const s of [512, 256, 128, 64, 48, 32, 16]) {
    writeFileSync(join(root, `build/icons/${s}x${s}.png`), img.resize({ width: s, height: s, quality: 'best' }).toPNG());
  }
  win.destroy();
  app.quit();
});
