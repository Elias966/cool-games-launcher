// Types for block-delta.mjs (used by the launcher's self-updater).
export declare const BLOCK_SIZE: number;
export interface BlockIndex { blockSize: number; size: number; count: number; weak: Uint32Array; strong: Buffer }
export declare function makeIndex(path: string, blockSize?: number): Buffer;
export declare function parseIndex(buf: Buffer): BlockIndex;
export declare function findLocalBlocks(oldPath: string, index: BlockIndex, onProgress?: (fraction: number) => void): Promise<Float64Array>;
export declare function missingRanges(found: Float64Array, index: BlockIndex, gap?: number): Array<[number, number]>;
