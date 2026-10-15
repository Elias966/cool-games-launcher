#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md from the vendor manifest and the npm
// packages that end up in the AppImage (runtime dependencies plus everything
// bundled into the main process, workers and renderer).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'scripts/vendor-manifest.json'), 'utf8'));
const models = JSON.parse(readFileSync(join(root, 'src/shared/model-catalog.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

// Packages bundled by esbuild/Vite even though they are devDependencies.
const BUNDLED = ['react', 'react-dom', 'three', '@react-three/fiber', 'motion', '@react-three/postprocessing', 'postprocessing', 'zod', '@fontsource-variable/space-grotesk', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono'];

function collect(names) {
  const seen = new Map();
  const visit = (name, from = '') => {
    const key = from ? `${from}/node_modules/${name}` : `node_modules/${name}`;
    const entry = lock.packages[key] ?? lock.packages[`node_modules/${name}`];
    const path = lock.packages[key] ? key : `node_modules/${name}`;
    if (!entry || seen.has(path)) return;
    const meta = existsSync(join(root, path, 'package.json')) ? JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) : {};
    seen.set(path, {
      name,
      version: entry.version,
      license: entry.license ?? meta.license ?? 'see package',
      homepage: meta.homepage ?? (typeof meta.repository === 'string' ? meta.repository : meta.repository?.url) ?? '',
    });
    for (const dep of Object.keys(entry.dependencies ?? {})) visit(dep, path);
  };
  for (const n of names) visit(n);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const runtime = collect([...Object.keys(pkg.dependencies), ...BUNDLED, 'electron']);

let md = `# Third-party notices

Cool Games Launcher is free software released under the GNU General Public
License, version 3 or (at your option) any later version. See \`LICENSE\`.

It bundles the components below. Each keeps its own license; the full license
texts ship inside the respective component directories of the AppImage
(\`resources/vendor/…\`, \`resources/app.asar\` / \`node_modules/…\`) and Electron's
\`LICENSES.chromium.html\`.

## Bundled applications, models and tools

| Component | Version | License | Source |
|---|---|---|---|
`;
for (const c of manifest.components) {
  md += `| ${c.name} | ${c.version.length > 20 ? c.version.slice(0, 12) : c.version} | ${c.license} | ${c.url.replace(/\/[^/]*$/, '/')} |\n`;
}
md += `
Notes:

- **Mozilla Firefox** is distributed unmodified apart from an enterprise
  \`distribution/policies.json\` (updates, telemetry and first-run pages turned
  off). Firefox and the Firefox logos are trademarks of the Mozilla Foundation.
  Source: https://archive.mozilla.org/pub/firefox/releases/
- **uBlock Origin** (GPL-3.0) is the unmodified, Mozilla-signed release.
  Source: https://github.com/gorhill/uBlock
- **Fara1.5-4B** (MIT), Microsoft Research. Optional browser-agent weights, quantized by bartowski. https://huggingface.co/microsoft/Fara1.5-4B
  Its published prompt and tool schema are adapted under the MIT license in resources/FARA-LICENSE.
- **Holo3.1-4B** (Apache-2.0), H Company. Optional computer/file-agent weights, quantized by mradermacher. https://huggingface.co/Hcompany/Holo-3.1-4B
- **Qwen3.5-4B** (Apache-2.0), Qwen Team. Optional vision/tool-agent weights, quantized by Unsloth. https://huggingface.co/Qwen/Qwen3.5-4B
- **GUI-Owl 1.5** (MIT), mPLUG / Tongyi Lab, Alibaba Group. GGUF models are
  downloaded only on request; they are not bundled. Quantization by mradermacher.
  Original model: https://huggingface.co/mPLUG/GUI-Owl-1.5-32B-Instruct
  Base Qwen3-VL model is Apache-2.0. License texts ship in resources/vendor/licenses.
- **vit-base-nsfw-detector** (Apache-2.0) by AdamCodd, fine-tuned from
  google/vit-base-patch16-384 (Apache-2.0). https://huggingface.co/AdamCodd/vit-base-nsfw-detector
- **llama.cpp / ggml** (MIT). https://github.com/ggml-org/llama.cpp
- **libgomp** (GPL-3.0-or-later with GCC Runtime Library Exception 3.1),
  from Ubuntu's GCC 12 packages. Copyright and exception text:
  \`resources/vendor/llama/runtime-licenses/usr/share/doc/gcc-12-base/copyright\`;
  GPLv3 text: \`resources/LICENSE\`. Sources: https://gcc.gnu.org/releases.html
- **7-Zip** (LGPL with unRAR restriction and BSD components). Complete binary redistribution notices are bundled at \`resources/vendor/7zip/License.txt\`. Source: https://github.com/ip7z/7zip/tree/26.04
- **umu-launcher** (GPL-3.0). https://github.com/Open-Wine-Components/umu-launcher
- **wasm-vips** bundles libvips (LGPL-2.1-or-later) and its image codecs
  compiled to WebAssembly; sources: https://github.com/kleisauke/wasm-vips
- Fonts: Space Grotesk, Inter and JetBrains Mono, SIL Open Font License 1.1.

## npm packages in the application

| Package | Version | License |
|---|---|---|
`;
for (const r of runtime) md += `| ${r.name} | ${r.version} | ${r.license} |\n`;

md += `\n## Components downloaded on demand\n\n| Component | Version | License | Source |\n|---|---|---|---|\n`;
for (const c of manifest.onDemand ?? []) md += `| ${c.name} | ${c.version} | ${c.license} | ${c.url} |\n`;
md += `\n## Optional local agent models\n\nModel weights and matching F16 vision projectors download only after an explicit Settings action. Each GGUF file is revision-pinned and SHA-256 verified. They are stored outside the AppImage.\n\n| Model | Quantization source | Revision |\n|---|---|---|\n`;
for (const model of models) md += `| ${model.name} | ${model.conversionUrl} | ${model.revision} |\n`;

md += `\n## Source excerpts\n\n| Item | Source | License |\n|---|---|---|\n| Fara1.5 system prompt and computer_use tool definition (src/shared/fara15-system-prompt.json), used verbatim as the model was trained on it | https://github.com/microsoft/fara (commit a675d6d), Copyright (c) 2025 Microsoft | MIT |\n| 3D simplex noise GLSL (src/renderer/scene/OrbitalScene.tsx) | Ashima Arts / Stefan Gustavson, webgl-noise | MIT |\n`;
md += `\nWine is optional and user-installed. GE-Proton is downloaded on demand and verified against the pinned SHA-256. Its component licenses and source references ship in its archive.\n`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), md);
console.log(`THIRD_PARTY_NOTICES.md: ${manifest.components.length} bundled components, ${runtime.length} npm packages`);
