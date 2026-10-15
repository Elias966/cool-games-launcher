import {describe,it,expect} from 'vitest';
import {recordAllocation,type ModelRuntime} from '../src/workers/inference-runtime';
describe('native GPU allocation evidence',()=>{
 it('distinguishes full, partial and unknown offload without inferring it from model size',()=>{
  const runtime:ModelRuntime={modelId:'test',device:'Vulkan1',gpuLayers:null,totalLayers:null,loadMs:null,allocations:[]};
  recordAllocation(runtime,'loading model');expect(runtime.gpuLayers).toBeNull();
  recordAllocation(runtime,'load_tensors: offloaded 20/33 layers to GPU');expect(runtime).toMatchObject({gpuLayers:20,totalLayers:33});
  recordAllocation(runtime,'load_tensors: offloaded 33/33 layers to GPU');expect(runtime.gpuLayers).toBe(runtime.totalLayers);
  recordAllocation(runtime,'load_tensors: Vulkan1 model buffer size = 2500 MiB');
  recordAllocation(runtime,'request: private data');expect(runtime.allocations).toEqual(['load_tensors: Vulkan1 model buffer size = 2500 MiB']);
 });
});
