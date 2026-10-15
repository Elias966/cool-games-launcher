// Read native allocation evidence, not model size or requested offload settings.
export interface ModelRuntime {
  modelId: string | null;
  device: string | null;
  gpuLayers: number | null;
  totalLayers: number | null;
  loadMs: number | null;
  allocations: string[];
}

export function recordAllocation(runtime: ModelRuntime, line: string) {
  const layers = line.match(/offloaded (\d+)\/(\d+) layers to GPU/i);
  if(layers) { runtime.gpuLayers=Number(layers[1]); runtime.totalLayers=Number(layers[2]); }
  // Only native buffer/backend allocation lines; never dump requests or keys.
  if(/(?:model|KV|compute) buffer size\s*=|using (?:CUDA\d*|Vulkan\d*|CPU) backend/i.test(line)) {
    if(runtime.allocations.length<40)runtime.allocations.push(line.trim().slice(0,300));
  }
}
