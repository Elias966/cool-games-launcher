// Cover filter scoring with CLIP (ViT-B/32 image encoder, ONNX fp16): how
// likely a game cover shows a woman or girl as its subject. The image is
// compared with fixed descriptions ("a game cover featuring an anime girl",
// "… a man", "… a monster", "… a logo" …) whose text embeddings were computed
// once from the same CLIP model (cover-prompts.json). ~10-70 ms per cover.
import { readFileSync } from 'node:fs';
import prompts from './cover-prompts.json';

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const SIZE = 224;

/** Probability mass of the "woman" descriptions (0..1) for a normalised image embedding. */
export function womanScore(image: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < image.length; i++) n += image[i] * image[i];
  n = Math.sqrt(n) || 1;
  const dot = (t: number[]) => { let s = 0; for (let i = 0; i < t.length; i++) s += (image[i] / n) * t[i]; return s * prompts.logitScale; };
  const logits = [...prompts.positiveEmbeds.map(dot), ...prompts.negativeEmbeds.map(dot)];
  const max = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - max));
  const total = ex.reduce((a, b) => a + b, 0);
  return ex.slice(0, prompts.positiveEmbeds.length).reduce((a, b) => a + b, 0) / total;
}

/** CLIP preprocessing: shortest edge to 224 (bicubic), centre crop, normalised CHW floats. */
export function pixels(vips: any, buf: Buffer): Float32Array {
  const temps: any[] = [];
  const keep = (x: any) => (temps.push(x), x);
  try {
    let im = keep(vips.Image.newFromBuffer(buf, '', { access: 'sequential' }));
    if (im.hasAlpha()) im = keep(im.flatten({ background: [255, 255, 255] }));
    if (im.interpretation !== 'srgb' && im.bands < 3) im = keep(im.colourspace('srgb'));
    if (im.bands === 1) im = keep(im.bandjoin([im, im]));
    if (im.bands > 3) im = keep(im.extractBand(0, { n: 3 }));
    im = keep(im.resize(SIZE / Math.min(im.width, im.height), { kernel: 'cubic' }));
    im = keep(im.extractArea(Math.max(0, Math.floor((im.width - SIZE) / 2)), Math.max(0, Math.floor((im.height - SIZE) / 2)), SIZE, SIZE));
    const raw: Uint8Array = im.writeToMemory();
    const plane = SIZE * SIZE;
    const out = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) out[c * plane + i] = (raw[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    return out;
  } finally {
    for (const t of temps) t.delete();
  }
}

export interface CoverScorer {
  score(path: string): Promise<number>;
  release(): Promise<void>;
  device: 'gpu' | 'cpu';
}

/** Loads the image encoder on the GPU (WebGPU), or the CPU when that fails. */
export async function createCoverScorer(modelPath: string, vips: any, log: (...a: unknown[]) => void = () => undefined): Promise<CoverScorer> {
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  let session: Awaited<ReturnType<typeof ort.InferenceSession.create>>;
  let device: 'gpu' | 'cpu' = 'gpu';
  const probe = new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]);
  try {
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    await session.run({ pixel_values: probe });
  } catch (e) {
    log('cover model: WebGPU unavailable, using CPU', (e as Error).message.slice(0, 200));
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' });
    device = 'cpu';
  }
  log('cover model ready', { device });
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>) => { const r = queue.then(fn, fn); queue = r.catch(() => undefined); return r; };
  return {
    device,
    score: (path) => exclusive(async () => {
      const input = new ort.Tensor('float32', pixels(vips, readFileSync(path)), [1, 3, SIZE, SIZE]);
      const r = await session.run({ pixel_values: input });
      return womanScore(r.image_embeds.data as Float32Array);
    }),
    release: () => exclusive(() => session.release()),
  };
}
