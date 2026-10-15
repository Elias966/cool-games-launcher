// Small stored RAR4 fixture builder. The real bundled decoder validates the
// header/data CRCs; no executable from this fixture is ever started.
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function checksum(header: Buffer) { header.writeUInt16LE(crc32(header.subarray(2)) & 0xffff, 0); return header; }
export function portableRar(files: Record<string, Buffer>): Buffer {
  const main = Buffer.alloc(13); main[2] = 0x73; main.writeUInt16LE(13, 5);
  const parts = [Buffer.from('526172211a0700', 'hex'), checksum(main)];
  for (const [name, data] of Object.entries(files)) {
    const filename = Buffer.from(name); const header = Buffer.alloc(32 + filename.length);
    header[2] = 0x74; header.writeUInt16LE(0x8000, 3); header.writeUInt16LE(header.length, 5);
    header.writeUInt32LE(data.length, 7); header.writeUInt32LE(data.length, 11);
    header[15] = 0; header.writeUInt32LE(crc32(data), 16); header[24] = 20; header[25] = 0x30;
    header.writeUInt16LE(filename.length, 26); header.writeUInt32LE(0x20, 28); filename.copy(header, 32);
    parts.push(checksum(header), data);
  }
  const end = Buffer.alloc(7); end[2] = 0x7b; end.writeUInt16LE(7, 5); parts.push(checksum(end));
  return Buffer.concat(parts);
}
