// NSFW image classifier (ViT, ONNX) with wasm-vips preprocessing. Used by the
// inference worker and by scripts/eval-classifier.mjs, so both measure the
// exact same pipeline.

const SIZE = 384;

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Classifier {
  /** NSFW probabilities: one per region, or one for the whole image when no regions are given. */
  score(image: Buffer, regions?: Region[], includeWhole?: boolean, signal?: AbortSignal): Promise<number[]>;
  /** Frees the model and its GPU memory; the classifier cannot be used afterwards. */
  release(): Promise<void>;
}

export async function createClassifier(modelPath: string, threads: number, log: (...a: unknown[]) => void = () => undefined): Promise<Classifier & { device: 'gpu' | 'cpu' }> {
  const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
  const cpu = () => ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
  // fp16 ViT on the GPU through WebGPU (Vulkan): ~35 ms per image versus ~1 s
  // on CPU, with scores identical to the fp32 reference. Any GPU/driver
  // problem falls back to the CPU with the same model and results.
  let session: Awaited<ReturnType<typeof cpu>>;
  let device: 'gpu' | 'cpu' = 'cpu';
  try {
    session = await ort.InferenceSession.create(modelPath, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
    await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) });
    device = 'gpu';
  } catch (e) {
    log('classifier: WebGPU unavailable, using CPU', (e as Error).message.slice(0, 200));
    session = await cpu();
  }
  log('classifier ready', { device });
  // One GPU/CPU inference at a time: concurrent runs only thrash; decoding still overlaps.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>) => { const r = queue.then(fn, fn); queue = r.catch(() => undefined); return r; };
  const init = require('wasm-vips');
  const vips = await init({ dynamicLibraries: [] });
  vips.concurrency(1);

  /** Converts an image to the model's input; every intermediate is freed (the wasm heap does not GC them). */
  const toTensorData = (img: any, out: Float32Array, temps: any[]) => {
    const keep = (x: any) => (temps.push(x), x);
    let im = img;
    if (im.hasAlpha()) im = keep(im.flatten({ background: [255, 255, 255] }));
    if (im.interpretation !== 'srgb') im = keep(im.colourspace('srgb'));
    if (im.bands > 3) im = keep(im.extractBand(0, { n: 3 }));
    if (im.bands === 1) im = keep(im.bandjoin([im, im]));
    // Same as the model's ViTImageProcessor: bilinear resize to 384×384, scale to [-1, 1].
    const resized = keep(im.width === SIZE && im.height === SIZE ? im.copy() : im.resize(SIZE / im.width, { vscale: SIZE / im.height, kernel: 'linear' }));
    const raw: Uint8Array = resized.writeToMemory();
    const plane = SIZE * SIZE;
    for (let i = 0; i < plane; i++) {
      out[i] = raw[i * 3] / 127.5 - 1;
      out[plane + i] = raw[i * 3 + 1] / 127.5 - 1;
      out[2 * plane + i] = raw[i * 3 + 2] / 127.5 - 1;
    }
  };

  const run = async (img: any, temps: any[], signal?: AbortSignal) => {
    const data = new Float32Array(3 * SIZE * SIZE);
    toTensorData(img, data, temps);
    const out = await exclusive(() => {
      // A tab switch can cancel dozens of queued screenshots. Do not keep
      // running them ahead of the next website's live verification work.
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      return session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, SIZE, SIZE]) });
    });
    const logits = out[session.outputNames[0]].data as Float32Array;
    const m = Math.max(logits[0], logits[1]);
    const sfw = Math.exp(logits[0] - m);
    const nsfw = Math.exp(logits[1] - m);
    return nsfw / (sfw + nsfw); // id2label: 0 = sfw, 1 = nsfw
  };

  return {
    device,
    release: () => exclusive(() => session.release()),
    async score(buf, regions, includeWhole, signal) {
      if (buf.length > 40 * 1024 * 1024) throw new Error('Image too large to classify');
      const temps: any[] = [];
      const cancelled = () => {
        if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      };
      try {
        const scores: number[] = [];
        if (!regions?.length || includeWhole) {
          // Shrink-on-load keeps large photos (4K+) cheap; the model sees 384×384 anyway.
          const thumb = vips.Image.thumbnailBuffer(buf, SIZE, { height: SIZE, size: 'force' });
          temps.push(thumb);
          if (thumb.width < 8 || thumb.height < 8) throw new Error('Image too small');
          cancelled();
          scores.push(await run(thumb, temps, signal));
        }
        if (regions?.length) {
          const image = vips.Image.newFromBuffer(buf, '', { access: 'random', fail: false });
          temps.push(image);
          for (const r of regions) {
            const x = Math.max(0, Math.floor(r.x));
            const y = Math.max(0, Math.floor(r.y));
            const w = Math.min(image.width - x, Math.floor(r.w));
            const h = Math.min(image.height - y, Math.floor(r.h));
            if (w < 24 || h < 24) {
              scores.push(Number.NaN); // keeps scores aligned with regions; callers treat NaN as unclassified
              continue;
            }
            cancelled();
            const crop = image.crop(x, y, w, h);
            temps.push(crop);
            scores.push(await run(crop, temps, signal));
          }
        }
        return scores;
      } finally {
        for (const t of temps) t.delete?.();
      }
    },
  };
}
