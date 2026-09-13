import { deflateSync } from "node:zlib";

/** Original two-joint ribbon and one-pixel paint, authored for Slopcamera tests. */
export function createOriginalRiggedGlbFixture(textured = false) {
  const binary = new Uint8Array(336), data = new DataView(binary.buffer);
  const floats = (offset: number, values: readonly number[]) => values.forEach((value, index) => data.setFloat32(offset + index * 4, value, true));
  floats(0, [-0.25, 0, 0, 0.25, 0, 0, -0.25, 2, 0, 0.25, 2, 0]);
  floats(48, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  floats(96, [0, 0, 1, 0, 0, 1, 1, 1]);
  binary.set([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 128);
  floats(144, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  floats(208, [...identity, ...identity.slice(0, 13), -1, 0, 1]);
  const indices = new Uint8Array([0, 1, 2, 1, 3, 2]);
  const withIndices = new Uint8Array(344); withIndices.set(binary); withIndices.set(indices, 336);
  const document: Record<string, unknown> = {
    asset: { version: "2.0", generator: "Slopcamera original two-joint ribbon fixture" },
    buffers: [{ byteLength: 342 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 32 }, { buffer: 0, byteOffset: 128, byteLength: 16 },
      { buffer: 0, byteOffset: 144, byteLength: 64 }, { buffer: 0, byteOffset: 208, byteLength: 128 },
      { buffer: 0, byteOffset: 336, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-0.25, 0, 0], max: [0.25, 2, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 4, type: "VEC2" },
      { bufferView: 3, componentType: 5121, count: 4, type: "VEC4" },
      { bufferView: 4, componentType: 5126, count: 4, type: "VEC4" },
      { bufferView: 5, componentType: 5126, count: 2, type: "MAT4" },
      { bufferView: 6, componentType: 5121, count: 6, type: "SCALAR" },
    ],
    scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { name: "asset-root", translation: [3, 0, 0], children: [1, 3] },
      { name: "hip", children: [2] },
      { name: "hand", translation: [0, 1, 0] },
      { name: "ribbon", mesh: 0, skin: 0 },
    ],
    skins: [{ name: "ribbon-skeleton", skeleton: 1, joints: [1, 2], inverseBindMatrices: 5 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 }, indices: 6, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 }, doubleSided: true }],
  };
  if (!textured) return { document, binary: withIndices, bytes: encodeOriginalRiggedGlbFixture(document, withIndices) };
  const png = originalOnePixelPng(), combined = new Uint8Array(Math.ceil((344 + png.length) / 4) * 4);
  combined.set(withIndices); combined.set(png, 344);
  document.buffers = [{ byteLength: 344 + png.length }];
  (document.bufferViews as unknown[]).push({ buffer: 0, byteOffset: 344, byteLength: png.length });
  document.images = [{ bufferView: 7, mimeType: "image/png" }];
  document.textures = [{ source: 0, sampler: 0 }];
  document.samplers = [{ wrapS: 33071, wrapT: 33648, minFilter: 9729, magFilter: 9728 }];
  ((document.materials as { pbrMetallicRoughness: Record<string, unknown> }[])[0]!).pbrMetallicRoughness.baseColorTexture = { index: 0 };
  return { document, binary: combined, bytes: encodeOriginalRiggedGlbFixture(document, combined) };
}

export function encodeOriginalRiggedGlbFixture(document: unknown, binary: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(document)), padded = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(28 + padded + binary.length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, padded, true); view.setUint32(16, 0x4e4f534a, true); bytes.fill(32, 20, 20 + padded); bytes.set(json, 20);
  view.setUint32(20 + padded, binary.length, true); view.setUint32(24 + padded, 0x004e4942, true); bytes.set(binary, 28 + padded);
  return bytes;
}

function originalOnePixelPng(): Uint8Array {
  const chunk = (type: string, payload: Uint8Array) => {
    const bytes = new Uint8Array(payload.length + 12), view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, bytes.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    view.setUint32(bytes.length - 4, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  };
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, 1); view.setUint32(4, 1); header[8] = 8; header[9] = 6;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(new Uint8Array([0, 90, 180, 220, 255]))), chunk("IEND", new Uint8Array())];
  const bytes = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
