import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fc from "fast-check";

import { parseSpatialGlb } from "../../../src/spatial-scene/gltf.js";
import { HtmlOverlayAuthoringInputSchema } from "./contracts";
import { createHtmlOverlayImportMap } from "./libraries";
import { createThreeRiggedGlbModule, prepareThreeRiggedGlb, THREE_RIGGED_GLB_PROFILE, type PreparedThreeRiggedGlb } from "./rigged-glb";
import { createOriginalRiggedGlbFixture, encodeOriginalRiggedGlbFixture } from "./rigged-glb.testing";

interface Vector {
  x: number; y: number; z: number;
  set(x: number, y: number, z: number): Vector;
  setScalar(value: number): Vector;
  toArray(): number[];
}
interface RigNode {
  name: string;
  position: Vector;
  scale: Vector;
  rotation: { z: number };
  quaternion: { toArray(): number[] };
  userData: { slopcameraNodeIndex: number };
  updateMatrixWorld(force: boolean): void;
  traverse(callback: (node: RigNode) => void): void;
  localToWorld(point: Vector): Vector;
  getVertexPosition(index: number, point: Vector): Vector;
  isSkinnedMesh?: boolean;
  frustumCulled: boolean;
  material: { map: TestTexture; color: { toArray(): number[] } };
}
interface Rig {
  root: RigNode;
  bones: readonly RigNode[];
  nodes: readonly RigNode[];
  boneByName(name: string): RigNode;
  resetPose(): void;
  dispose(): void;
}
interface TestTexture {
  flipY: boolean;
  colorSpace: string;
  wrapS: number;
  wrapT: number;
  minFilter: number;
  magFilter: number;
  generateMipmaps: boolean;
  clone(): TestTexture;
  dispose(): void;
}
const THREE = createRequire(import.meta.url)("three") as Readonly<{
  Vector3: new (x?: number, y?: number, z?: number) => Vector;
  Texture: new () => TestTexture;
  ClampToEdgeWrapping: number;
  MirroredRepeatWrapping: number;
  LinearFilter: number;
  NearestFilter: number;
  SRGBColorSpace: string;
}>;
const options = { name: "ribbon", provenance: { source: "authored" as const, description: "Original Slopcamera two-joint ribbon", license: "MIT" } };
function prepare(document?: unknown, binary?: Uint8Array): PreparedThreeRiggedGlb {
  const fixture = createOriginalRiggedGlbFixture();
  return prepareThreeRiggedGlb(encodeOriginalRiggedGlbFixture(document ?? fixture.document, binary ?? fixture.binary), options);
}
async function instantiate(prepared = prepare(), three: unknown = THREE, asset: (name: string) => string = name => name): Promise<Rig> {
  const source = createThreeRiggedGlbModule(prepared).replace("export async function createRig", "async function createRig");
  const factory = new Function("SlopcameraOverlay", `${source}\nreturn createRig;`)({ asset }) as (three: unknown) => Promise<Rig>;
  return factory(three);
}
function skinnedMesh(rig: Rig): RigNode {
  let mesh: RigNode | undefined;
  rig.root.traverse(node => { if (node.isSkinnedMesh) mesh = node; });
  if (!mesh) throw new Error("Missing fixture skinned mesh.");
  return mesh;
}
function vertices(rig: Rig): number[][] {
  rig.root.updateMatrixWorld(true);
  const mesh = skinnedMesh(rig);
  return Array.from({ length: 4 }, (_, index) => mesh.localToWorld(mesh.getVertexPosition(index, new THREE.Vector3())).toArray());
}

describe("prepared core-Three rigged GLB", () => {
  test("retains exact original source provenance and inspectable rest bounds", () => {
    const fixture = createOriginalRiggedGlbFixture(), result = prepareThreeRiggedGlb(fixture.bytes, options);
    expect(result.inspection).toMatchObject({
      profile: THREE_RIGGED_GLB_PROFILE,
      source: { bytes: fixture.bytes.length, sha256: createHash("sha256").update(fixture.bytes).digest("hex"), provenance: options.provenance },
      bounds: { min: [2.75, 0, 0], max: [3.25, 2, 0] }, primitiveCount: 1, triangleCount: 2, vertexCount: 4,
      bones: [{ nodeIndex: 1, name: "hip", parentNodeIndex: 0 }, { nodeIndex: 2, name: "hand", parentNodeIndex: 1 }],
    });
    expect(Object.isFrozen(result.inspection.source.provenance)).toBe(true);
    expect(() => parseSpatialGlb(fixture.bytes)).toThrow();
  });

  test("deforms a real SkinnedMesh and resets under outer staging without double transforms", async () => {
    const rig = await instantiate();
    rig.root.position.set(10, 4, -2); rig.root.scale.setScalar(2);
    const initial = vertices(rig);
    expect(initial).toEqual([[15.5, 4, -2], [16.5, 4, -2], [15.5, 8, -2], [16.5, 8, -2]]);
    rig.boneByName("hand").rotation.z = Math.PI / 2;
    const turned = vertices(rig);
    expect(turned[0]).toEqual(initial[0]); expect(turned[1]).toEqual(initial[1]);
    expect(turned[2]![0]).toBeCloseTo(14, 10); expect(turned[2]![1]).toBeCloseTo(5.5, 10);
    expect(turned[3]![0]).toBeCloseTo(14, 10); expect(turned[3]![1]).toBeCloseTo(6.5, 10);
    expect(skinnedMesh(rig).frustumCulled).toBe(false);
    rig.resetPose(); expect(vertices(rig)).toEqual(initial);
    expect(rig.root.position.toArray()).toEqual([10, 4, -2]);
    expect(rig.bones.map(bone => bone.userData.slopcameraNodeIndex)).toEqual([1, 2]);
    rig.dispose(); rig.dispose(); expect(() => rig.resetPose()).toThrow("disposed");
  });

  test("repeated absolute poses agree after arbitrary intervening poses and staging", async () => {
    const rig = await instantiate();
    try {
      fc.assert(fc.property(fc.integer({ min: -500, max: 500 }), fc.integer({ min: -500, max: 500 }), fc.integer({ min: 1, max: 100 }), (first, second, scale) => {
        rig.root.position.set(first / 10, second / 10, 2); rig.root.scale.setScalar(scale / 10);
        const pose = (angle: number) => { rig.resetPose(); rig.boneByName("hand").rotation.z = angle / 100; return vertices(rig); };
        const a = pose(first); pose(second); const repeated = pose(first);
        expect(repeated).toEqual(a); expect(repeated.flat().every(Number.isFinite)).toBe(true);
      }), { numRuns: 50 });
    } finally { rig.dispose(); }
  });

  test("normalized byte weights preserve linear blending across the entire byte range", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 255 }), async weight => {
      const fixture = createOriginalRiggedGlbFixture();
      (fixture.document.accessors as Record<string, unknown>[])[4] = { bufferView: 4, componentType: 5121, count: 4, type: "VEC4", normalized: true };
      for (let vertex = 0; vertex < 4; vertex++) {
        fixture.binary.set([0, 1, 0, 0], 128 + vertex * 4);
        fixture.binary.set([weight, 255 - weight, 0, 0], 144 + vertex * 4);
      }
      const rig = await instantiate(prepare(fixture.document, fixture.binary));
      try {
        rig.boneByName("hand").rotation.z = Math.PI / 2;
        const point = vertices(rig)[2]!, hipWeight = weight / 255;
        expect(point[0]).toBeCloseTo(2.75 * hipWeight + 2 * (1 - hipWeight), 6);
        expect(point[1]).toBeCloseTo(2 * hipWeight + 0.75 * (1 - hipWeight), 6);
        expect(point[2]).toBe(0);
      } finally { rig.dispose(); }
    }), { numRuns: 30, examples: [[0], [255]] });
  });

  test("TRS-decomposable matrix nodes preserve rest geometry and resettable bone poses", async () => {
    const fixture = createOriginalRiggedGlbFixture(), nodes = fixture.document.nodes as Record<string, unknown>[];
    delete nodes[0]!.translation;
    nodes[0]!.matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1];
    const rig = await instantiate(prepare(fixture.document));
    try {
      expect(vertices(rig)).toEqual([[2.75, 0, 0], [3.25, 0, 0], [2.75, 2, 0], [3.25, 2, 0]]);
      rig.boneByName("hand").rotation.z = 1; rig.resetPose();
      expect(rig.boneByName("hand").quaternion.toArray()).toEqual([0, 0, 0, 1]);
    } finally { rig.dispose(); }
  });

  test("extracts declared textures and maps glTF sampling enums to Three constants", async () => {
    const fixture = createOriginalRiggedGlbFixture(true), result = prepareThreeRiggedGlb(fixture.bytes, options);
    const requests: string[] = [];
    class TextureLoader {
      loadAsync(url: string): Promise<TestTexture> { requests.push(url); return Promise.resolve(new THREE.Texture()); }
    }
    const rig = await instantiate(result, { ...THREE, TextureLoader }, name => `/declared/${name}`);
    try {
      expect(requests).toEqual(["/declared/ribbon-image-0"]);
      expect(result.resources.map(resource => resource.declaration.mediaType)).toEqual(["text/javascript", "image/png"]);
      const image = result.resources[1]!;
      expect(image.declaration.sha256).toBe(createHash("sha256").update(image.bytes).digest("hex"));
      expect(image.bytes.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(skinnedMesh(rig).material.map).toMatchObject({ flipY: false, colorSpace: THREE.SRGBColorSpace,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.MirroredRepeatWrapping, magFilter: THREE.NearestFilter, minFilter: THREE.LinearFilter, generateMipmaps: false });
      expect(skinnedMesh(rig).material.color.toArray()).toEqual([0.2, 0.4, 0.8]);
      const authoring = HtmlOverlayAuthoringInputSchema.parse({ kind: "slopcamera.html-overlay", schemaVersion: 1,
        html: "<!doctype html><html><body></body></html>", canvas: { width: 256, height: 256, deviceScaleFactor: 1 }, timing: { fps: 30, durationUs: 1_000_000 }, seed: 1,
        libraries: ["three"], resources: result.resources.map(resource => resource.declaration), parameters: {} });
      expect(authoring.libraries).toEqual(["three"]);
      expect(Object.keys(createHtmlOverlayImportMap(authoring.libraries).imports)).toEqual(["three"]);
    } finally { rig.dispose(); }
  });

  test("generated bytes are deterministic, detached, and contain no executable model text", () => {
    const fixture = createOriginalRiggedGlbFixture();
    (fixture.document.nodes as { name: string }[])[2]!.name = "</script><script>throw 'injected'</script>\u2028";
    const a = prepare(fixture.document), b = prepare(fixture.document);
    expect(a.moduleSource).toBe(b.moduleSource); expect(a.resources).toEqual(b.resources);
    expect(a.moduleSource).not.toContain("</script>");
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(a.moduleSource)).not.toThrow();
    const resource = a.resources[0]!; resource.bytes.fill(0);
    expect(a.resources[0]!.declaration.sha256).toBe(createHash("sha256").update(a.resources[0]!.bytes).digest("hex"));
    expect(() => createThreeRiggedGlbModule({ moduleSource: "forged" } as PreparedThreeRiggedGlb)).toThrow("requires a prepared");
  });

  test("ambiguous bone names require explicit source node addressing", async () => {
    const fixture = createOriginalRiggedGlbFixture();
    (fixture.document.nodes as { name: string }[])[2]!.name = "hip";
    const rig = await instantiate(prepare(fixture.document));
    try { expect(() => rig.boneByName("hip")).toThrow("found 2"); expect(rig.nodes[2]!.userData.slopcameraNodeIndex).toBe(2); }
    finally { rig.dispose(); }
  });
});

describe("rigged GLB profile rejection", () => {
  test("rejects compressed assets, morph targets, clips, external dependencies and unsupported fields", () => {
    const mutate = (edit: (document: Record<string, unknown>) => void) => {
      const fixture = createOriginalRiggedGlbFixture(); edit(fixture.document); return () => prepare(fixture.document, fixture.binary);
    };
    expect(mutate(document => { document.extensionsUsed = ["KHR_draco_mesh_compression"]; })).toThrow("Draco");
    expect(mutate(document => { (document.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!.targets = [{ POSITION: 0 }]; })).toThrow("Morph");
    expect(mutate(document => { document.animations = [{}]; })).toThrow("Animation clips");
    expect(mutate(document => { document.buffers = [{ uri: "https://example.invalid/source.bin", byteLength: 342 }]; })).toThrow();
    expect(mutate(document => { document.extensionsRequired = ["EXT_meshopt_compression"]; })).toThrow();
    expect(mutate(document => { (document.meshes as { primitives: { attributes: Record<string, unknown> }[] }[])[0]!.primitives[0]!.attributes.JOINTS_1 = 3; })).toThrow();
  });

  test("rejects malformed hierarchy, palettes, skin weights, inverse binds and view roles", () => {
    const mutate = (edit: (document: Record<string, unknown>, binary: Uint8Array) => void) => {
      const fixture = createOriginalRiggedGlbFixture(); edit(fixture.document, fixture.binary); return () => prepare(fixture.document, fixture.binary);
    };
    expect(mutate(document => { (document.skins as { joints: number[] }[])[0]!.joints = [1, 1]; })).toThrow("unique");
    expect(mutate(document => { (document.skins as { skeleton: number }[])[0]!.skeleton = 3; })).toThrow("ancestor");
    expect(mutate(document => { (document.nodes as { skin?: number }[])[3]!.skin = 12; })).toThrow("missing index");
    expect(mutate(document => { (document.nodes as { children?: number[] }[])[2]!.children = [0]; })).toThrow();
    expect(mutate((_document, binary) => { binary[128] = 2; })).toThrow("palette");
    expect(mutate((_document, binary) => { new DataView(binary.buffer).setFloat32(144, 0, true); })).toThrow("sum to one");
    expect(mutate((_document, binary) => { new DataView(binary.buffer).setFloat32(144, -1, true); })).toThrow("nonnegative");
    expect(mutate((_document, binary) => { new DataView(binary.buffer).setFloat32(208, 0, true); })).toThrow("Inverse bind");
    expect(mutate((_document, binary) => { new DataView(binary.buffer).setFloat32(220, 0.5, true); })).toThrow("Inverse bind");
    expect(mutate(document => { (document.accessors as { normalized?: boolean }[])[3]!.normalized = true; })).toThrow("JOINTS_0");
    expect(mutate(document => { (document.bufferViews as { target?: number }[])[5]!.target = 34962; })).toThrow("untargeted");
    expect(mutate(document => { (document.accessors as { bufferView: number }[])[4]!.bufferView = 0; })).toThrow();
  });

  test("rejects finite but oversized allocations before accessor decoding", () => {
    const fixture = createOriginalRiggedGlbFixture();
    (fixture.document.accessors as { count: number }[])[3]!.count = 2_000_000;
    expect(() => prepare(fixture.document)).toThrow();
    expect(() => prepareThreeRiggedGlb(new Uint8Array(new SharedArrayBuffer(32)), options)).toThrow("non-shared");
  });

  test("foreign options reject getters without invocation, and arbitrary short bytes never prepare", () => {
    let invoked = false;
    const foreign = { get name() { invoked = true; return "ribbon"; }, provenance: options.provenance };
    expect(() => prepareThreeRiggedGlb(createOriginalRiggedGlbFixture().bytes, foreign)).toThrow(); expect(invoked).toBe(false);
    fc.assert(fc.property(fc.uint8Array({ maxLength: 256 }), bytes => {
      expect(() => prepareThreeRiggedGlb(bytes, options)).toThrow();
    }), { numRuns: 100 });
  });
});
