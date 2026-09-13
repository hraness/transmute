import { z } from "zod";

import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot.js";
import { createSha256HexHasher } from "../../../src/code/sha256.js";
import { evaluateSpatialGlb, parseSpatialGlb, SPATIAL_GLB_LIMITS, type SpatialGlbImage, type SpatialGlbPrimitive } from "../../../src/spatial-scene/gltf.js";
import { composeTransform, IDENTITY_MATRIX, invertTransform, multiplyTransforms, transformPoint, type Bounds, type Mat4, type Vec3 } from "../../../src/spatial-scene/math.js";
import { canonicalJson } from "../core/canonical-json";
import { HtmlOverlayDeclaredResourcesSchema, type HtmlOverlayDeclaredResource } from "./contracts";

/** An HTML Three asset profile. The portable spatial-scene GLB profile remains unchanged. */
export const THREE_RIGGED_GLB_PROFILE = "slopcamera.three-skinned-glb-trs-pbr-basecolor-v1" as const;
export const THREE_RIGGED_GLB_LIMITS = Object.freeze({
  ...SPATIAL_GLB_LIMITS,
  nodes: 1024,
  skins: 64,
  jointsPerSkin: 256,
  images: 32,
  moduleBytes: 32 * 1024 * 1024,
});

const nodeIndex = z.number().int().min(0).max(THREE_RIGGED_GLB_LIMITS.nodes - 1);
const accessorIndex = z.number().int().min(0).max(SPATIAL_GLB_LIMITS.accessors - 1);
const finite = z.number().finite().min(-1e6).max(1e6);
const vec3 = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]);
const ProvenanceSchema = z.strictObject({
  source: z.enum(["authored", "imported"]),
  description: z.string().trim().min(1).max(4096),
  sourceUrl: z.url().max(2048).refine(value => /^https?:\/\//u.test(value), "Expected an HTTP(S) provenance URL.").optional(),
  license: z.string().trim().min(1).max(1024).optional(),
  attribution: z.string().trim().min(1).max(4096).optional(),
});
const OptionsSchema = z.strictObject({
  name: z.string().min(1).max(32).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  provenance: ProvenanceSchema,
});
const SkinSchema = z.strictObject({
  name: z.string().max(1024).optional(),
  extras: z.unknown().optional(),
  joints: z.array(nodeIndex).min(1).max(THREE_RIGGED_GLB_LIMITS.jointsPerSkin),
  inverseBindMatrices: accessorIndex.optional(),
  skeleton: nodeIndex.optional(),
});
const NodeProjectionSchema = z.object({
  name: z.string().max(1024).optional(),
  children: z.array(nodeIndex).max(THREE_RIGGED_GLB_LIMITS.nodes).default([]),
  mesh: z.number().int().min(0).max(SPATIAL_GLB_LIMITS.meshes - 1).optional(),
  skin: z.number().int().min(0).max(THREE_RIGGED_GLB_LIMITS.skins - 1).optional(),
  translation: vec3.default([0, 0, 0]),
  rotation: quaternion.default([0, 0, 0, 1]),
  scale: vec3.default([1, 1, 1]),
  matrix: z.array(finite).length(16).optional(),
});
type RigNode = z.infer<typeof NodeProjectionSchema>;
type SkinInput = z.infer<typeof SkinSchema>;
type RigSkin = Readonly<{ joints: readonly number[]; inverseBindMatrices: readonly Mat4[] }>;
type RigPrimitive = SpatialGlbPrimitive & Readonly<{
  skin?: number;
  joints?: readonly number[];
  weights?: readonly number[];
}>;
type RigData = Readonly<{ nodes: readonly RigNode[]; roots: readonly number[]; skins: readonly RigSkin[]; primitives: readonly RigPrimitive[] }>;
export type ThreeRiggedGlbProvenance = Readonly<z.infer<typeof ProvenanceSchema>>;
export type ThreeRiggedGlbPrepareOptions = Readonly<z.infer<typeof OptionsSchema>>;
export interface ThreeRiggedGlbResource {
  readonly declaration: HtmlOverlayDeclaredResource;
  /** A detached copy. Write these bytes and bind this declaration together. */
  readonly bytes: Uint8Array;
}
export interface ThreeRiggedGlbInspection {
  readonly profile: typeof THREE_RIGGED_GLB_PROFILE;
  readonly source: Readonly<{ bytes: number; sha256: string; provenance: ThreeRiggedGlbProvenance }>;
  readonly bounds: Bounds;
  readonly primitiveCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  readonly bones: readonly Readonly<{ nodeIndex: number; name: string; parentNodeIndex: number | null }>[];
  readonly images: readonly Readonly<{ width: number; height: number; declaration: HtmlOverlayDeclaredResource }>[];
}

function fail(message: string): never {
  throw new RangeError(`${THREE_RIGGED_GLB_PROFILE}: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} exceeds its array profile.`);
  return value;
}
function at<T>(values: readonly T[], index: number, label: string): T {
  return values[index] ?? fail(`${label} references missing index ${index}.`);
}
function boundedValue(value: unknown, label: string): unknown {
  return createBoundedJsonValueSnapshot(value, SPATIAL_GLB_LIMITS.jsonBytes, label, {
    maximumDepth: SPATIAL_GLB_LIMITS.jsonDepth, maximumValues: SPATIAL_GLB_LIMITS.jsonValues,
  }).value;
}
function digest(bytes: Uint8Array): string {
  const hasher = createSha256HexHasher();
  hasher.update(bytes);
  return hasher.digestHex();
}

function readEnvelope(input: Uint8Array) {
  if (!(input instanceof Uint8Array) || input.byteLength < 28 || input.byteLength > SPATIAL_GLB_LIMITS.bytes || input.buffer instanceof SharedArrayBuffer) {
    fail("Expected bounded, non-shared GLB 2.0 bytes.");
  }
  const bytes = Uint8Array.from(input), view = new DataView(bytes.buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length) fail("Invalid GLB 2.0 header or total length.");
  const jsonLength = view.getUint32(12, true), binHeader = 20 + jsonLength;
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength < 4 || jsonLength % 4 !== 0 || jsonLength > SPATIAL_GLB_LIMITS.jsonBytes || binHeader + 8 > bytes.length) fail("Expected bounded JSON and BIN chunks.");
  const binLength = view.getUint32(binHeader, true);
  if (view.getUint32(binHeader + 4, true) !== 0x004e4942 || binLength % 4 !== 0 || binHeader + 8 + binLength !== bytes.length) fail("Expected exactly one BIN chunk without trailing data.");
  let json: unknown;
  try { json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, binHeader))); }
  catch { return fail("GLB JSON must be valid UTF-8 JSON."); }
  return { bytes, document: object(boundedValue(json, "rigged GLB"), "glTF"), binary: bytes.subarray(binHeader + 8) };
}

function envelope(document: unknown, binary: Uint8Array): Uint8Array {
  const raw = new TextEncoder().encode(canonicalJson(document));
  if (raw.length > SPATIAL_GLB_LIMITS.jsonBytes) fail("Lowered geometry JSON exceeds the existing static decoder profile.");
  const jsonLength = Math.ceil(raw.length / 4) * 4;
  const bytes = new Uint8Array(28 + jsonLength + binary.length), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(raw, 20);
  view.setUint32(20 + jsonLength, binary.length, true); view.setUint32(24 + jsonLength, 0x004e4942, true); bytes.set(binary, 28 + jsonLength);
  return bytes;
}

/** After the unchanged static decoder has checked every accessor's storage and finite values. */
function accessorValues(document: Record<string, unknown>, binary: Uint8Array, index: number, components: number) {
  const accessors = array(document.accessors, SPATIAL_GLB_LIMITS.accessors, "accessors");
  const source = object(at(accessors, index, "accessor"), "accessor");
  const views = array(document.bufferViews, SPATIAL_GLB_LIMITS.bufferViews, "bufferViews");
  const view = object(at(views, source.bufferView as number, "bufferView"), "bufferView");
  const componentBytes = source.componentType === 5121 ? 1 : source.componentType === 5123 ? 2 : 4;
  const stride = (view.byteStride as number | undefined) ?? components * componentBytes;
  const offset = ((view.byteOffset as number | undefined) ?? 0) + ((source.byteOffset as number | undefined) ?? 0);
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength), values: number[] = [];
  for (let item = 0; item < (source.count as number); item++) for (let component = 0; component < components; component++) {
    const address = offset + item * stride + component * componentBytes;
    const raw = source.componentType === 5121 ? data.getUint8(address) : source.componentType === 5123 ? data.getUint16(address, true) : data.getFloat32(address, true);
    values.push(source.normalized ? raw / (source.componentType === 5121 ? 255 : 65535) : raw);
  }
  return { source, view, stride, offset, values };
}

function checkViewRoles(document: Record<string, unknown>, skins: readonly SkinInput[]): void {
  const roles = new Map<number, string>(), vertices = new Map<number, Set<number>>();
  const accessors = document.accessors as Record<string, unknown>[], views = document.bufferViews as Record<string, unknown>[];
  const assign = (index: number, role: string) => {
    const prior = roles.get(index);
    if (prior !== undefined && prior !== role) fail(`Buffer view mixes ${prior} and ${role} data.`);
    roles.set(index, role);
  };
  const accessor = (index: number, role: string) => {
    const source = at(accessors, index, "accessor"), view = source.bufferView as number;
    assign(view, role);
    if (role === "vertex") { const ids = vertices.get(view) ?? new Set<number>(); ids.add(index); vertices.set(view, ids); }
  };
  for (const mesh of document.meshes as { primitives: { attributes: Record<string, number>; indices?: number }[] }[]) for (const primitive of mesh.primitives) {
    for (const index of Object.values(primitive.attributes)) accessor(index, "vertex");
    if (primitive.indices !== undefined) accessor(primitive.indices, "index");
  }
  for (const skin of skins) if (skin.inverseBindMatrices !== undefined) accessor(skin.inverseBindMatrices, "skin");
  for (const image of (document.images ?? []) as { bufferView: number }[]) assign(image.bufferView, "image");
  for (const [view, ids] of vertices) if (ids.size > 1 && at(views, view, "bufferView").byteStride === undefined) fail("Shared vertex views require explicit stride, including joint and weight attributes.");
}

function prepareData(document: Record<string, unknown>, binary: Uint8Array): { data: RigData; images: readonly SpatialGlbImage[]; bounds: Bounds; parents: readonly (number | null)[] } {
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) if (Array.isArray(document[field]) && document[field].includes("KHR_draco_mesh_compression")) fail("Draco-compressed geometry is unsupported; provide an explicitly decoded uncompressed GLB derivative and retain its original source.");
  if (array(document.animations ?? [], SPATIAL_GLB_LIMITS.clips, "animations").length !== 0) fail("Animation clips are unsupported in this profile; author bone poses on the absolute frame clock.");
  const skinInputs = array(document.skins, THREE_RIGGED_GLB_LIMITS.skins, "skins").map(value => SkinSchema.parse(value));
  if (skinInputs.length === 0) fail("At least one skin is required.");
  const nodesRaw = array(document.nodes, THREE_RIGGED_GLB_LIMITS.nodes, "nodes");
  const nodes = nodesRaw.map(value => NodeProjectionSchema.parse(value));
  for (const node of nodes) if (node.skin !== undefined) {
    at(skinInputs, node.skin, "skin");
    if (node.mesh === undefined) fail("A skin requires a mesh on the same node.");
  }
  const accessors = array(document.accessors, SPATIAL_GLB_LIMITS.accessors, "accessors").map(value => object(value, "accessor"));
  const inverseIds = new Set(skinInputs.flatMap(skin => skin.inverseBindMatrices === undefined ? [] : [skin.inverseBindMatrices]));
  for (const skin of skinInputs) {
    if (new Set(skin.joints).size !== skin.joints.length) fail("Skin joints must be unique.");
    for (const joint of skin.joints) at(nodes, joint, "skin joint");
    if (skin.skeleton !== undefined) at(nodes, skin.skeleton, "skeleton");
    if (skin.inverseBindMatrices !== undefined) {
      const source = at(accessors, skin.inverseBindMatrices, "inverse bind accessor");
      if (source.type !== "MAT4" || source.componentType !== 5126 || source.normalized === true || source.count !== skin.joints.length || source.min !== undefined || source.max !== undefined) fail("Inverse binds require unnormalized float32 MAT4 values matching the joint count, without min/max.");
    }
  }
  const meshes = array(document.meshes, SPATIAL_GLB_LIMITS.meshes, "meshes").map(value => object(value, "mesh"));
  const rigAttributes = meshes.map(mesh => array(mesh.primitives, SPATIAL_GLB_LIMITS.primitives, "primitives").map(value => {
    const primitive = object(value, "primitive"), attributes = object(primitive.attributes, "attributes");
    if (primitive.targets !== undefined) fail("Morph targets are unsupported in this profile.");
    const joints = attributes.JOINTS_0 === undefined ? undefined : accessorIndex.parse(attributes.JOINTS_0);
    const weights = attributes.WEIGHTS_0 === undefined ? undefined : accessorIndex.parse(attributes.WEIGHTS_0);
    if ((joints === undefined) !== (weights === undefined)) fail("JOINTS_0 and WEIGHTS_0 must be supplied together.");
    return { joints, weights };
  }));
  // Strip only the independently validated skin fields. The static profile still
  // checks all remaining fields, geometry, materials, images, storage and hierarchy.
  const { skins: _skins, ...base } = document;
  const lowered = {
    ...base,
    nodes: nodesRaw.map(value => { const { skin: _skin, ...node } = object(value, "node"); return node; }),
    meshes: meshes.map(mesh => ({ ...mesh, primitives: (mesh.primitives as unknown[]).map(value => {
      const primitive = object(value, "primitive");
      const { JOINTS_0: _joints, WEIGHTS_0: _weights, ...attributes } = object(primitive.attributes, "attributes");
      return { ...primitive, attributes };
    }) })),
    accessors: accessors.map((source, index) => {
      if (source.type !== "MAT4") return source;
      if (!inverseIds.has(index)) fail("MAT4 accessors are admitted only as inverse bind matrices.");
      return { ...source, type: "VEC4", count: (source.count as number) * 4 };
    }),
  };
  const geometry = evaluateSpatialGlb(parseSpatialGlb(envelope(lowered, binary)), { metersPerUnit: 1, sourceUp: "y", timeUs: 0, materialMode: "source" });
  if (geometry.images.length > THREE_RIGGED_GLB_LIMITS.images) fail("Extracted texture count exceeds this profile.");
  checkViewRoles(document, skinInputs);
  const skins = skinInputs.map(skin => {
    if (skin.inverseBindMatrices === undefined) return { joints: skin.joints, inverseBindMatrices: skin.joints.map(() => IDENTITY_MATRIX) };
    const decoded = accessorValues(document, binary, skin.inverseBindMatrices, 16);
    if (decoded.view.byteStride !== undefined || decoded.view.target !== undefined) fail("Inverse binds require tightly packed untargeted storage.");
    const inverseBindMatrices = skin.joints.map((_, index) => {
      const matrix = decoded.values.slice(index * 16, index * 16 + 16) as unknown as Mat4;
      try { invertTransform(matrix); } catch { fail("Inverse bind matrices must be bounded invertible affine transforms."); }
      return matrix;
    });
    return { joints: skin.joints, inverseBindMatrices };
  });
  const parents: (number | null)[] = nodes.map(() => null);
  nodes.forEach((node, index) => node.children.forEach(child => { parents[child] = index; }));
  const scenes = document.scenes as { nodes: number[] }[];
  const roots = at(scenes, (document.scene as number | undefined) ?? 0, "scene").nodes;
  const reachable = new Set<number>(), pending = [...roots];
  const matrices = new Map<number, Mat4>();
  while (pending.length) {
    const index = pending.shift()!, node = nodes[index]!;
    reachable.add(index);
    const local = node.matrix ? node.matrix as unknown as Mat4 : composeTransform({ position: node.translation, rotation: node.rotation, scale: node.scale });
    matrices.set(index, multiplyTransforms(parents[index] === null ? IDENTITY_MATRIX : matrices.get(parents[index]!)!, local));
    pending.push(...node.children);
  }
  for (const skin of skinInputs) {
    if (skin.joints.some(index => !reachable.has(index))) fail("Every joint must belong to the selected default scene.");
    if (skin.skeleton !== undefined) for (const joint of skin.joints) {
      let current: number | null = joint;
      while (current !== null && current !== skin.skeleton) current = parents[current]!;
      if (current === null) fail("The declared skeleton must be an ancestor of every skin joint.");
    }
  }
  const decodedAttributes = rigAttributes.map((mesh, meshIndex) => mesh.map((attributes, primitiveIndex) => {
    if (attributes.joints === undefined || attributes.weights === undefined) return undefined;
    const primitive = (meshes[meshIndex]!.primitives as { attributes: { POSITION: number } }[])[primitiveIndex]!;
    const vertexCount = accessors[primitive.attributes.POSITION]!.count;
    const joints = accessorValues(document, binary, attributes.joints, 4), weights = accessorValues(document, binary, attributes.weights, 4);
    if (joints.source.type !== "VEC4" || ![5121, 5123].includes(joints.source.componentType as number) || joints.source.normalized === true) fail("JOINTS_0 requires unnormalized unsigned byte/short VEC4.");
    if (weights.source.type !== "VEC4" || !(weights.source.componentType === 5126 && weights.source.normalized !== true || [5121, 5123].includes(weights.source.componentType as number) && weights.source.normalized === true)) fail("WEIGHTS_0 requires float32 or normalized unsigned byte/short VEC4.");
    for (const attribute of [joints, weights]) {
      if (attribute.source.count !== vertexCount || attribute.offset % 4 !== 0 || attribute.stride % 4 !== 0 || (attribute.view.target !== undefined && attribute.view.target !== 34962)) fail("Skin attributes require matching vertex counts, four-byte alignment, and ARRAY_BUFFER storage.");
    }
    for (let index = 0; index < weights.values.length; index += 4) {
      const vertex = weights.values.slice(index, index + 4), sum = vertex.reduce((total, value) => total + value, 0);
      if (vertex.some(value => value < 0 || value > 1) || Math.abs(sum - 1) > 1e-4) fail("Skin weights must be nonnegative and sum to one per vertex.");
      for (let component = 0; component < 4; component++) weights.values[index + component] = vertex[component]! / sum;
    }
    return { joints: joints.values, weights: weights.values };
  }));
  for (const node of nodes) if (node.mesh !== undefined) for (const attributes of decodedAttributes[node.mesh]!) {
    if (node.skin === undefined) {
      if (attributes !== undefined) fail("Joint attributes require an explicit skin on every mesh instance.");
    } else {
      if (attributes === undefined) fail("Every skinned primitive requires JOINTS_0 and WEIGHTS_0.");
      if (attributes.joints.some(value => value >= skins[node.skin!]!.joints.length)) fail("A joint attribute exceeds the skin joint palette.");
    }
  }
  let skinned = false;
  const primitives = geometry.primitives.map(primitive => {
    const node = nodes[primitive.sourceNodeIndex]!;
    if (node.skin === undefined) return primitive;
    skinned = true;
    return { ...primitive, skin: node.skin, ...decodedAttributes[node.mesh!]![primitive.sourcePrimitiveIndex]! };
  });
  if (!skinned) fail("The selected scene must contain at least one skinned triangle primitive.");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of primitives as RigPrimitive[]) {
    const skin = primitive.skin === undefined ? undefined : skins[primitive.skin]!;
    const skinMatrices = skin?.joints.map((node, index) => multiplyTransforms(matrices.get(node)!, skin.inverseBindMatrices[index]!));
    for (const vertex of primitive.indices ?? Array.from({ length: primitive.positions.length / 3 }, (_, index) => index)) {
      const position: Vec3 = [primitive.positions[vertex * 3]!, primitive.positions[vertex * 3 + 1]!, primitive.positions[vertex * 3 + 2]!];
      let point: readonly number[];
      if (!skinMatrices) point = transformPoint(primitive.matrix, position);
      else {
        const weighted = [0, 0, 0];
        for (let component = 0; component < 4; component++) {
          const index = vertex * 4 + component, weight = primitive.weights![index]!;
          const transformed = transformPoint(skinMatrices[primitive.joints![index]!]!, position);
          for (let axis = 0; axis < 3; axis++) weighted[axis] = weighted[axis]! + weight * transformed[axis]!;
        }
        point = weighted;
      }
      for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis]!, point[axis]!); max[axis] = Math.max(max[axis]!, point[axis]!); }
    }
  }
  const bounds: Bounds = { min: min as unknown as Vec3, max: max as unknown as Vec3 };
  return { data: deepFreezeJson({ nodes, roots, skins, primitives }), images: geometry.images, bounds: deepFreezeJson(bounds), parents };
}

function moduleSource(data: RigData, images: readonly { imageIndex: number; declaration: HtmlOverlayDeclaredResource }[]): string {
  const embedded = canonicalJson({ ...data, images: images.map(({ imageIndex, declaration }) => ({ imageIndex, declaration })) }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `// ${THREE_RIGGED_GLB_PROFILE}\nconst data=${embedded};
export async function createRig(THREE) {
  const textureResults=await Promise.allSettled(data.images.map(image=>Promise.resolve().then(()=>new THREE.TextureLoader().loadAsync(SlopcameraOverlay.asset(image.declaration.name)))));
  const sourceTextures=textureResults.filter(result=>result.status==="fulfilled").map(result=>result.value);
  const rejected=textureResults.find(result=>result.status==="rejected");
  if(rejected){sourceTextures.forEach(texture=>texture.dispose());throw rejected.reason;}
  const textureByImage=new Map(data.images.map((image,index)=>[image.imageIndex,sourceTextures[index]]));
  const root=new THREE.Group(),geometries=[],materials=[],textures=[...sourceTextures],skeletons=[];
  let disposed=false;
  const nodes=data.nodes.map((source,index)=>{
    const node=new THREE.Bone();node.name=source.name??("node-"+index);node.userData.slopcameraNodeIndex=index;
    if(source.matrix){node.matrix.fromArray(source.matrix);node.matrix.decompose(node.position,node.quaternion,node.scale);}
    else{node.position.fromArray(source.translation);node.quaternion.fromArray(source.rotation).normalize();node.scale.fromArray(source.scale);}
    return node;
  });
  const rest=nodes.map(node=>({position:node.position.clone(),quaternion:node.quaternion.clone(),scale:node.scale.clone()}));
  data.nodes.forEach((source,index)=>source.children.forEach(child=>nodes[index].add(nodes[child])));
  data.roots.forEach(index=>root.add(nodes[index]));root.updateMatrixWorld(true);
  try {
    data.skins.forEach(skin=>skeletons.push(new THREE.Skeleton(skin.joints.map(index=>nodes[index]),skin.inverseBindMatrices.map(matrix=>new THREE.Matrix4().fromArray(matrix)))));
    data.primitives.forEach(primitive=>{
      const geometry=new THREE.BufferGeometry();geometries.push(geometry);
      geometry.setAttribute("position",new THREE.Float32BufferAttribute(primitive.positions,3));
      if(primitive.normals)geometry.setAttribute("normal",new THREE.Float32BufferAttribute(primitive.normals,3));
      if(primitive.uvs)geometry.setAttribute("uv",new THREE.Float32BufferAttribute(primitive.uvs,2));
      if(primitive.indices)geometry.setIndex(primitive.indices);
      if(!primitive.normals)geometry.computeVertexNormals();
      const source=primitive.material,color=source.baseColorLinear;
      const material=new THREE.MeshStandardMaterial({color:new THREE.Color().setRGB(color[0],color[1],color[2],THREE.LinearSRGBColorSpace),opacity:color[3],metalness:source.metalness,roughness:source.roughness,transparent:source.alphaMode==="BLEND",alphaTest:source.alphaMode==="MASK"?source.alphaCutoff:0,side:source.doubleSided?THREE.DoubleSide:THREE.FrontSide});
      materials.push(material);
      if(source.baseColorTexture){
        const binding=source.baseColorTexture,texture=textureByImage.get(binding.imageIndex).clone();textures.push(texture);
        const wraps={33071:THREE.ClampToEdgeWrapping,33648:THREE.MirroredRepeatWrapping,10497:THREE.RepeatWrapping};
        const filters={9728:THREE.NearestFilter,9729:THREE.LinearFilter,9984:THREE.NearestMipmapNearestFilter,9985:THREE.LinearMipmapNearestFilter,9986:THREE.NearestMipmapLinearFilter,9987:THREE.LinearMipmapLinearFilter};
        texture.flipY=false;texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=wraps[binding.sampler.wrapS];texture.wrapT=wraps[binding.sampler.wrapT];
        texture.magFilter=filters[binding.sampler.magFilter??9729];texture.minFilter=filters[binding.sampler.minFilter??9987];texture.generateMipmaps=(binding.sampler.minFilter??9987)>=9984;
        texture.needsUpdate=true;material.map=texture;
      }
      let mesh;
      if(primitive.skin===undefined)mesh=new THREE.Mesh(geometry,material);
      else{
        geometry.setAttribute("skinIndex",new THREE.Uint16BufferAttribute(primitive.joints,4));geometry.setAttribute("skinWeight",new THREE.Float32BufferAttribute(primitive.weights,4));
        mesh=new THREE.SkinnedMesh(geometry,material);mesh.frustumCulled=false;
      }
      mesh.name=nodes[primitive.sourceNodeIndex].name+"-primitive-"+primitive.sourcePrimitiveIndex;nodes[primitive.sourceNodeIndex].add(mesh);
      if(primitive.skin!==undefined)mesh.bind(skeletons[primitive.skin],new THREE.Matrix4());
    });
  } catch(error) {geometries.forEach(value=>value.dispose());materials.forEach(value=>value.dispose());textures.forEach(value=>value.dispose());skeletons.forEach(value=>value.dispose());throw error;}
  const indices=[...new Set(data.skins.flatMap(skin=>skin.joints))].sort((a,b)=>a-b),bones=Object.freeze(indices.map(index=>nodes[index]));
  const resetPose=()=>{
    if(disposed)throw new Error("Rig is disposed.");
    nodes.forEach((node,index)=>{const source=rest[index];node.position.copy(source.position);node.quaternion.copy(source.quaternion);node.scale.copy(source.scale);});
    root.updateMatrixWorld(true);skeletons.forEach(skeleton=>skeleton.update());
  };
  resetPose();
  return Object.freeze({root,bones,nodes:Object.freeze(nodes),resetPose,
    boneByName(name){const found=bones.filter(bone=>bone.name===name);if(found.length!==1)throw new Error("Expected exactly one bone named "+name+"; found "+found.length+". Use nodes[sourceNodeIndex] for ambiguous names.");return found[0];},
    dispose(){if(disposed)return;disposed=true;root.removeFromParent();geometries.forEach(value=>value.dispose());materials.forEach(value=>value.dispose());textures.forEach(value=>value.dispose());skeletons.forEach(value=>value.dispose());}
  });
}
`;
}

/** Opaque preparation retains verified source identity and detached generated resources. */
export class PreparedThreeRiggedGlb {
  readonly profile = THREE_RIGGED_GLB_PROFILE;
  readonly inspection: ThreeRiggedGlbInspection;
  readonly moduleResource: HtmlOverlayDeclaredResource;
  readonly #moduleSource: string;
  readonly #resources: readonly ThreeRiggedGlbResource[];

  private constructor(input: Uint8Array, optionsInput: ThreeRiggedGlbPrepareOptions) {
    const options = OptionsSchema.parse(boundedValue(optionsInput, "rig preparation options"));
    const { bytes, document, binary } = readEnvelope(input);
    const { data, images, bounds, parents } = prepareData(document, binary), sha256 = digest(bytes);
    const imageResources = images.map(image => {
      const declaration: HtmlOverlayDeclaredResource = { name: `${options.name}-image-${image.imageIndex}`, urlPath: `rig/${options.name}/${sha256}/image-${image.imageIndex}.${image.mimeType === "image/png" ? "png" : "jpg"}`, mediaType: image.mimeType, bytes: image.bytes.length, sha256: digest(image.bytes) };
      return { imageIndex: image.imageIndex, width: image.width, height: image.height, declaration, bytes: image.bytes };
    });
    this.#moduleSource = moduleSource(data, imageResources);
    const moduleBytes = new TextEncoder().encode(this.#moduleSource);
    if (moduleBytes.length > THREE_RIGGED_GLB_LIMITS.moduleBytes) fail("Generated module exceeds the bounded module byte profile.");
    this.moduleResource = Object.freeze({ name: `${options.name}-module`, urlPath: `rig/${options.name}/${sha256}/rig.mjs`, mediaType: "text/javascript", bytes: moduleBytes.length, sha256: digest(moduleBytes) });
    HtmlOverlayDeclaredResourcesSchema.parse([this.moduleResource, ...imageResources.map(image => image.declaration)]);
    this.#resources = [{ declaration: this.moduleResource, bytes: moduleBytes }, ...imageResources.map(image => ({ declaration: Object.freeze(image.declaration), bytes: image.bytes }))];
    const jointIndices = [...new Set(data.skins.flatMap(skin => skin.joints))].sort((a, b) => a - b);
    this.inspection = deepFreezeJson({
      profile: this.profile, source: { bytes: bytes.length, sha256, provenance: options.provenance }, bounds,
      primitiveCount: data.primitives.length,
      triangleCount: data.primitives.reduce((sum, primitive) => sum + (primitive.indices?.length ?? primitive.positions.length / 3) / 3, 0),
      vertexCount: data.primitives.reduce((sum, primitive) => sum + primitive.positions.length / 3, 0),
      bones: jointIndices.map(nodeIndex => ({ nodeIndex, name: data.nodes[nodeIndex]!.name ?? `node-${nodeIndex}`, parentNodeIndex: parents[nodeIndex]! })),
      images: imageResources.map(({ width, height, declaration }) => ({ width, height, declaration })),
    });
    Object.freeze(this);
  }

  get resources(): readonly ThreeRiggedGlbResource[] {
    return Object.freeze(this.#resources.map(resource => Object.freeze({ declaration: resource.declaration, bytes: resource.bytes.slice() })));
  }
  get moduleSource(): string { return this.#moduleSource; }
  static prepare(bytes: Uint8Array, options: ThreeRiggedGlbPrepareOptions): PreparedThreeRiggedGlb { return new PreparedThreeRiggedGlb(bytes, options); }
}

/** Pure preparation: no files, network, decoder downloads, or browser execution. */
export function prepareThreeRiggedGlb(bytes: Uint8Array, options: ThreeRiggedGlbPrepareOptions): PreparedThreeRiggedGlb {
  return PreparedThreeRiggedGlb.prepare(bytes, options);
}

/** A declared local module exporting async createRig(THREE), using core Three only. */
export function createThreeRiggedGlbModule(prepared: PreparedThreeRiggedGlb): string {
  if (!(prepared instanceof PreparedThreeRiggedGlb)) fail("Module generation requires a prepared rigged GLB.");
  return prepared.moduleSource;
}
