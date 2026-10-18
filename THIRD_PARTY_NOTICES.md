# Third-party notices

Cool Games Launcher is free software released under the GNU General Public
License, version 3 or (at your option) any later version. See `LICENSE`.

It bundles the components below. Each keeps its own license; the full license
texts ship inside the respective component directories of the AppImage
(`resources/vendor/…`, `resources/app.asar` / `node_modules/…`) and Electron's
`LICENSES.chromium.html`.

## Bundled applications, models and tools

| Component | Version | License | Source |
|---|---|---|---|
| Mozilla Firefox | 156.0.1 | MPL-2.0 | https://archive.mozilla.org/pub/firefox/releases/156.0.1/linux-x86_64/en-US/ |
| geckodriver | 0.37.1 | MPL-2.0 | https://github.com/mozilla/geckodriver/releases/download/v0.37.1/ |
| uBlock Origin | 1.75.0 | GPL-3.0 | https://github.com/gorhill/uBlock/releases/download/1.75.0/ |
| Cookie-Editor | 1.13.0 | GPL-3.0-only | https://addons.mozilla.org/firefox/downloads/file/4241002/ |
| llama.cpp (CPU build) | b11553 | MIT | https://github.com/ggml-org/llama.cpp/releases/download/b11553/ |
| llama.cpp (Vulkan build) | b11553 | MIT | https://github.com/ggml-org/llama.cpp/releases/download/b11553/ |
| vit-base-nsfw-detector (ONNX, fp16) | 8587de998f44 | Apache-2.0 | https://huggingface.co/AdamCodd/vit-base-nsfw-detector/resolve/8587de998f441aac03fdd57a85d2e4cb808c7d64/onnx/ |
| umu-launcher (zipapp) | 1.4.4 | GPL-3.0 | https://github.com/Open-Wine-Components/umu-launcher/releases/download/1.4.4/ |
| GCC OpenMP runtime (libgomp) | 12.3.0-1ubun | GPL-3.0-or-later WITH GCC-exception-3.1 | https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-12/ |
| GCC runtime license texts | 12.3.0-1ubun | GPL-3.0-or-later WITH GCC-exception-3.1 | https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-12/ |
| 7-Zip standalone archive decoder | 26.04 | LGPL-2.1-or-later AND BSD-2-Clause AND BSD-3-Clause AND unRAR restriction | https://github.com/ip7z/7zip/releases/download/26.04/ |
| GUI-Owl MIT license | 08e7da63cb06 | MIT | https://raw.githubusercontent.com/X-PLUG/MobileAgent/08e7da63cb06866306c3502569f4fd216baa2941/ |
| Qwen3-VL Apache license | e8c6dfbe0472 | Apache-2.0 | https://raw.githubusercontent.com/QwenLM/Qwen3-VL/e8c6dfbe0472e567b1bedc7640f550e0e506429f/ |
| Qwen3-VL Thinking chat template | 92f3c4b4fead | Apache-2.0 | https://huggingface.co/Qwen/Qwen3-VL-8B-Thinking/resolve/92f3c4b4feadd3a016ef468d103bb5f58b2a2c6b/ |
| legendary (Epic Games) | 0.21.1 | GPL-3.0 | https://github.com/legendary-gl/legendary/releases/download/0.21.1/ |
| heroic-gogdl (GOG) | 1.3.0 | GPL-3.0 | https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v1.3.0/ |

Notes:

- **ooz** (GPL-3.0), powzix, pinned source and complete local isolated helper source/build instructions ship in `resources/vendor/ooz`. It decodes bounded game configuration metadata. Source: https://github.com/powzix/ooz
- **Mozilla Firefox** ships with enterprise policies (updates, telemetry and first-run pages turned
  off) and the launcher’s local AutoConfig bridge for optional normal browser mode.
  Bridge source: `resources/firefox` in this repository. Firefox and the Firefox logos are trademarks of the Mozilla Foundation.
  Source: https://archive.mozilla.org/pub/firefox/releases/
- **uBlock Origin** (GPL-3.0) is the unmodified, Mozilla-signed release.
  Source: https://github.com/gorhill/uBlock
- **Cookie-Editor** (GPL-3.0-only) is the unmodified signed Firefox add-on by Moustachauve / cgagnier.
  Source: https://github.com/Moustachauve/cookie-editor
- **CLIP ViT-B/32 image encoder** (MIT), OpenAI; ONNX fp16 conversion by Xenova. Downloaded on demand for the cover filter, pinned revision d15189d7, SHA-256 verified. https://huggingface.co/Xenova/clip-vit-base-patch32 (original: https://github.com/openai/CLIP)
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
  `resources/vendor/llama/runtime-licenses/usr/share/doc/gcc-12-base/copyright`;
  GPLv3 text: `resources/LICENSE`. Sources: https://gcc.gnu.org/releases.html
- **7-Zip** (LGPL with unRAR restriction and BSD components). Complete binary redistribution notices are bundled at `resources/vendor/7zip/License.txt`. Source: https://github.com/ip7z/7zip/tree/26.04
- **umu-launcher** (GPL-3.0). https://github.com/Open-Wine-Components/umu-launcher
- **wasm-vips** bundles libvips (LGPL-2.1-or-later) and its image codecs
  compiled to WebAssembly; sources: https://github.com/kleisauke/wasm-vips
- Fonts: Space Grotesk, Inter and JetBrains Mono, SIL Open Font License 1.1.

## npm packages in the application

| Package | Version | License |
|---|---|---|
| @asamuzakjp/css-color | 7.1.5 | MIT |
| @asamuzakjp/dom-selector | 9.2.4 | MIT |
| @babel/runtime | 7.29.10 | MIT |
| @bazel/runfiles | 6.5.0 | Apache-2.0 |
| @bramus/specificity | 2.4.3 | MIT |
| @csstools/color-helpers | 6.1.2 | MIT-0 |
| @csstools/css-calc | 3.4.3 | MIT |
| @csstools/css-color-parser | 4.2.6 | MIT |
| @csstools/css-parser-algorithms | 4.0.2 | MIT |
| @csstools/css-syntax-patches-for-csstree | 1.1.15 | MIT-0 |
| @csstools/css-tokenizer | 4.0.2 | MIT |
| @electron-internal/extract-zip | 1.0.5 | BSD-2-Clause |
| @electron/get | 5.1.0 | MIT |
| @exodus/bytes | 1.16.0 | MIT |
| @fontsource-variable/inter | 5.3.0 | OFL-1.1 |
| @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 |
| @fontsource-variable/noto-sans-arabic | 5.3.0 | OFL-1.1 |
| @fontsource-variable/space-grotesk | 5.3.0 | OFL-1.1 |
| @isaacs/fs-minipass | 4.0.1 | ISC |
| @react-three/fiber | 9.8.1 | MIT |
| @react-three/postprocessing | 3.1.3 | MIT |
| @types/node | 24.19.2 | MIT |
| @types/react-reconciler | 0.28.9 | MIT |
| @types/webxr | 0.5.24 | MIT |
| adm-zip | 0.6.1 | MIT |
| base64-js | 1.5.1 | MIT |
| bidi-js | 1.1.0 | MIT |
| buffer | 6.0.3 | MIT |
| chownr | 3.0.0 | BlueOak-1.0.0 |
| core-util-is | 1.0.3 | MIT |
| css-tree | 3.2.1 | MIT |
| data-urls | 8.0.0 | MIT |
| debug | 4.4.3 | MIT |
| decimal.js | 10.6.0 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-properties | 1.2.1 | MIT |
| electron | 44.7.0 | MIT |
| entities | 8.1.0 | BSD-2-Clause |
| env-paths | 3.0.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| escape-string-regexp | 4.0.0 | MIT |
| framer-motion | 12.43.0 | MIT |
| global-agent | 4.1.3 | BSD-3-Clause |
| globalthis | 1.0.4 | MIT |
| gopd | 1.2.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| has-property-descriptors | 1.0.2 | MIT |
| hls.js | 1.6.13 | Apache-2.0 |
| html-encoding-sniffer | 7.0.0 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| immediate | 3.0.6 | MIT |
| inherits | 2.0.4 | ISC |
| is-potential-custom-element-name | 1.0.1 | MIT |
| isarray | 1.0.0 | MIT |
| its-fine | 2.1.1 | MIT |
| jsdom | 30.1.2 | MIT |
| jszip | 3.10.2 | (MIT OR GPL-3.0-or-later) |
| lie | 3.3.0 | MIT |
| lru-cache | 11.5.3 | BlueOak-1.0.0 |
| lru-cache | 11.5.3 | BlueOak-1.0.0 |
| lru-cache | 11.5.3 | BlueOak-1.0.0 |
| maath | 0.10.8 | MIT |
| matcher | 4.0.0 | MIT |
| mdn-data | 2.27.1 | CC0-1.0 |
| minipass | 7.1.3 | BlueOak-1.0.0 |
| minizlib | 3.1.0 | MIT |
| motion | 12.43.0 | MIT |
| motion-dom | 12.43.0 | MIT |
| motion-utils | 12.39.0 | MIT |
| ms | 2.1.3 | MIT |
| n8ao | 2.0.1 | ISC |
| object-keys | 1.1.1 | MIT |
| onnxruntime-common | 1.30.0 | MIT |
| onnxruntime-node | 1.30.0 | MIT |
| pako | 1.0.11 | (MIT AND Zlib) |
| parse5 | 8.0.1 | MIT |
| pend | 1.2.0 | MIT |
| postprocessing | 6.39.5 | Zlib |
| process-nextick-args | 2.0.1 | MIT |
| progress | 2.0.3 | MIT |
| punycode | 2.3.1 | MIT |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| react-use-measure | 2.1.7 | MIT |
| readable-stream | 2.3.8 | MIT |
| require-from-string | 2.0.2 | MIT |
| safe-buffer | 5.1.2 | MIT |
| saxes | 6.0.0 | ISC |
| scheduler | 0.27.0 | MIT |
| scheduler | 0.28.0 | MIT |
| selenium-webdriver | 4.51.0 | Apache-2.0 |
| semver | 7.8.5 | ISC |
| serialize-error | 8.1.0 | MIT |
| setimmediate | 1.0.5 | MIT |
| source-map-js | 1.2.2 | BSD-3-Clause |
| string_decoder | 1.1.1 | MIT |
| sumchecker | 3.0.1 | Apache-2.0 |
| suspend-react | 0.1.3 | MIT |
| tar | 7.5.22 | BlueOak-1.0.0 |
| three | 0.181.2 | MIT |
| tldts | 7.4.18 | MIT |
| tldts-core | 7.4.18 | MIT |
| tmp | 0.2.7 | MIT |
| tough-cookie | 6.0.2 | BSD-3-Clause |
| tr46 | 7.0.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| type-fest | 0.20.2 | (MIT OR CC0-1.0) |
| undici | 8.11.2 | MIT |
| undici-types | 7.24.6 | MIT |
| use-sync-external-store | 1.7.0 | MIT |
| util-deprecate | 1.0.2 | MIT |
| w3c-xmlserializer | 6.0.0 | MIT |
| wasm-vips | 0.0.19 | MIT |
| webidl-conversions | 8.0.1 | BSD-2-Clause |
| whatwg-mimetype | 5.0.0 | MIT |
| whatwg-url | 17.2.0 | MIT |
| ws | 8.22.0 | MIT |
| xml-name-validator | 5.0.0 | Apache-2.0 |
| xmlchars | 2.2.0 | MIT |
| yallist | 5.0.0 | BlueOak-1.0.0 |
| yauzl | 3.4.0 | MIT |
| zod | 4.6.6 | MIT |
| zustand | 5.0.15 | MIT |

## Components downloaded on demand

| Component | Version | License | Source |
|---|---|---|---|
| GE-Proton | GE-Proton11-7 | BSD-3-Clause (Proton) with bundled Wine (LGPL-2.1) and other components | https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton11-7/GE-Proton11-7-x86_64.tar.gz |

## Optional local agent models

Model weights and matching F16 vision projectors download only after an explicit Settings action. Each GGUF file is revision-pinned and SHA-256 verified. They are stored outside the AppImage.

| Model | Quantization source | Revision |
|---|---|---|
| Fara1.5-9B | https://huggingface.co/bartowski/Fara1.5-9B-GGUF | 153cb27ac91d4a2b9391ecf278542e610d040178 |
| Fara1.5-4B | https://huggingface.co/bartowski/Fara1.5-4B-GGUF | b97f335231e01efbbad37bb89b5310340fc10735 |
| Holo3.1-4B | https://huggingface.co/mradermacher/Holo-3.1-4B-GGUF | 6d76eab0233f62783ddec95a7a2e2b057c6d7e66 |
| Qwen3.5-4B | https://huggingface.co/unsloth/Qwen3.5-4B-GGUF | e87f176479d0855a907a41277aca2f8ee7a09523 |
| GUI-Owl-1.5-2B-Instruct | https://huggingface.co/mradermacher/GUI-Owl-1.5-2B-Instruct-GGUF | a0592aa615540e507a918bc6281fdbfc1b441361 |
| GUI-Owl-1.5-4B-Instruct | https://huggingface.co/mradermacher/GUI-Owl-1.5-4B-Instruct-GGUF | f77e8a457158e773d9f3135ff0cac5811878d3b7 |
| GUI-Owl-1.5-8B-Instruct | https://huggingface.co/mradermacher/GUI-Owl-1.5-8B-Instruct-GGUF | 01351d78b510be5bb41af59a3fab9b6a76b38218 |
| GUI-Owl-1.5-8B-Thinking | https://huggingface.co/mradermacher/GUI-Owl-1.5-8B-Think-GGUF | b739067ffb63d5761b2a059c1e19ffe6ebec6dd4 |
| GUI-Owl-1.5-32B-Instruct | https://huggingface.co/mradermacher/GUI-Owl-1.5-32B-Instruct-GGUF | 0fa26590cb51daf8e46030abd4cd55404efc38bf |
| GUI-Owl-1.5-32B-Thinking | https://huggingface.co/mradermacher/GUI-Owl-1.5-32B-Think-GGUF | b9baf1017f3ca6d74f2a69ac7be6a44edde60eb3 |

## Source excerpts

| Item | Source | License |
|---|---|---|
| Fara1.5 system prompt and computer_use tool definition (src/shared/fara15-system-prompt.json), used verbatim as the model was trained on it | https://github.com/microsoft/fara (commit a675d6d), Copyright (c) 2025 Microsoft | MIT |
| 3D simplex noise GLSL (src/renderer/scene/OrbitalScene.tsx) | Ashima Arts / Stefan Gustavson, webgl-noise | MIT |

Wine is optional and user-installed. GE-Proton is downloaded on demand and verified against the pinned SHA-256. Its component licenses and source references ship in its archive.
