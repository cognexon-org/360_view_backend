export type PresignObject = (objectKey: string, expiresSeconds: number) => Promise<string>;

export type VisualLod = {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  objectKey?: string;
  url?: string;
  maxDistanceM?: number;
  maxTriangles?: number;
};

export type VisualCollision = {
  shape: 'BOX' | 'SPHERE' | 'CYLINDER' | 'CONVEX';
  boundsM?: { width: number; depth: number; height: number };
  centerM?: [number, number, number];
};

export type VisualAssetContract = {
  fit: 'UNIFORM_CONTAIN' | 'EXACT_SIZE' | 'NATIVE';
  coordinateSystem: 'Y_UP' | 'Z_UP';
  unit: 'metre' | 'centimetre' | 'millimetre';
  lods: VisualLod[];
  collision: VisualCollision;
  castShadow: boolean;
  receiveShadow: boolean;
  tags: string[];
};

export type MaterialTextureContract = {
  baseColor?: string;
  normal?: string;
  roughness?: string;
  metallic?: string;
  ao?: string;
  height?: string;
  emissive?: string;
  opacity?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dimensions(value: unknown): { width: number; depth: number; height: number } {
  const r = record(value);
  return {
    width: Math.max(0.001, finite(r.width ?? r.x, 1)),
    depth: Math.max(0.001, finite(r.depth ?? r.z, 1)),
    height: Math.max(0.001, finite(r.height ?? r.y, 1)),
  };
}

function textArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 32) : [];
}

export function visualAssetContract(asset: {
  dimensionsM: unknown;
  glbObjectKey: string;
  metadata?: unknown;
}): VisualAssetContract {
  const metadata = record(asset.metadata);
  const visual = record(metadata.visual);
  const collisionRaw = record(visual.collision);
  const nativeDimensions = dimensions(asset.dimensionsM);
  const rawLods = Array.isArray(visual.lods) ? visual.lods : [];
  const lods: VisualLod[] = rawLods
    .map((entry) => record(entry))
    .map((entry, index) => ({
      level: String(entry.level ?? (index === 0 ? 'HIGH' : index === 1 ? 'MEDIUM' : 'LOW')).toUpperCase() as VisualLod['level'],
      objectKey: entry.objectKey ? String(entry.objectKey) : undefined,
      url: entry.url ? String(entry.url) : undefined,
      maxDistanceM: entry.maxDistanceM == null ? undefined : Math.max(0, finite(entry.maxDistanceM, 0)),
      maxTriangles: entry.maxTriangles == null ? undefined : Math.max(0, Math.round(finite(entry.maxTriangles, 0))),
    }))
    .filter((lod) => ['HIGH', 'MEDIUM', 'LOW'].includes(lod.level));

  if (!lods.some((lod) => lod.level === 'HIGH')) {
    lods.unshift({ level: 'HIGH', objectKey: asset.glbObjectKey, maxDistanceM: 8 });
  }

  const collisionShape = String(collisionRaw.shape ?? 'BOX').toUpperCase();
  const center = Array.isArray(collisionRaw.centerM) && collisionRaw.centerM.length >= 3
    ? collisionRaw.centerM.slice(0, 3).map((value) => finite(value, 0)) as [number, number, number]
    : [0, nativeDimensions.height / 2, 0] as [number, number, number];

  return {
    fit: ['EXACT_SIZE', 'NATIVE'].includes(String(visual.fit).toUpperCase())
      ? String(visual.fit).toUpperCase() as VisualAssetContract['fit']
      : 'UNIFORM_CONTAIN',
    coordinateSystem: String(visual.coordinateSystem).toUpperCase() === 'Z_UP' ? 'Z_UP' : 'Y_UP',
    unit: ['centimetre', 'millimetre'].includes(String(visual.unit).toLowerCase())
      ? String(visual.unit).toLowerCase() as VisualAssetContract['unit']
      : 'metre',
    lods,
    collision: {
      shape: ['SPHERE', 'CYLINDER', 'CONVEX'].includes(collisionShape)
        ? collisionShape as VisualCollision['shape']
        : 'BOX',
      boundsM: dimensions(collisionRaw.boundsM ?? nativeDimensions),
      centerM: center,
    },
    castShadow: visual.castShadow !== false,
    receiveShadow: visual.receiveShadow !== false,
    tags: textArray(visual.tags ?? metadata.tags),
  };
}

export function materialTextureContract(textureSet: unknown): MaterialTextureContract {
  const source = record(textureSet);
  const result: MaterialTextureContract = {};
  const aliases: Array<[keyof MaterialTextureContract, string[]]> = [
    ['baseColor', ['baseColor', 'basecolor', 'albedo', 'diffuse']],
    ['normal', ['normal', 'normalMap']],
    ['roughness', ['roughness', 'roughnessMap']],
    ['metallic', ['metallic', 'metalness', 'metallicMap']],
    ['ao', ['ao', 'ambientOcclusion', 'occlusion']],
    ['height', ['height', 'displacement']],
    ['emissive', ['emissive']],
    ['opacity', ['opacity', 'alpha']],
  ];
  for (const [target, names] of aliases) {
    const found = names.map((name) => source[name]).find((value) => typeof value === 'string' && value.trim());
    if (found) result[target] = String(found);
  }
  return result;
}

function isHttp(value: string): boolean { return /^https?:\/\//i.test(value); }

async function signedValue(value: string | undefined, presign: PresignObject, expiresSeconds: number): Promise<string | undefined> {
  if (!value) return undefined;
  if (isHttp(value) || value.startsWith('/')) return value;
  return presign(value, expiresSeconds);
}

export async function signedVisualAsset(asset: {
  id: string;
  name: string;
  category: string;
  glbObjectKey: string;
  thumbnailKey?: string | null;
  dimensionsM: unknown;
  anchor?: unknown;
  placementRules?: unknown;
  polygonCount?: number | null;
  textureBytes?: bigint | number | string | null;
  metadata?: unknown;
}, presign: PresignObject, expiresSeconds = 900) {
  const visual = visualAssetContract(asset);
  const resolvedLods = await Promise.all(visual.lods.map(async (lod) => ({
    ...lod,
    url: await signedValue(lod.url ?? lod.objectKey, presign, expiresSeconds),
  })));
  return {
    id: asset.id,
    name: asset.name,
    category: asset.category,
    dimensionsM: asset.dimensionsM,
    anchor: asset.anchor ?? null,
    placementRules: asset.placementRules ?? null,
    polygonCount: asset.polygonCount ?? null,
    textureBytes: asset.textureBytes == null ? null : String(asset.textureBytes),
    thumbnailUrl: await signedValue(asset.thumbnailKey ?? undefined, presign, expiresSeconds),
    primaryUrl: resolvedLods.find((lod) => lod.level === 'HIGH')?.url,
    visual: { ...visual, lods: resolvedLods },
  };
}

export async function signedMaterial(material: {
  id: string;
  name: string;
  category: string;
  supplier?: string | null;
  sku?: string | null;
  textureSet?: unknown;
  physical?: unknown;
  realWorldSizeM?: unknown;
  costPerUnit?: number | null;
  unit?: string | null;
}, presign: PresignObject, expiresSeconds = 900) {
  const textures = materialTextureContract(material.textureSet);
  const resolved: MaterialTextureContract = {};
  for (const [key, value] of Object.entries(textures) as Array<[keyof MaterialTextureContract, string]>) {
    const url = await signedValue(value, presign, expiresSeconds);
    if (url) resolved[key] = url;
  }
  return {
    id: material.id,
    name: material.name,
    category: material.category,
    supplier: material.supplier ?? null,
    sku: material.sku ?? null,
    textureSet: resolved,
    physical: material.physical ?? null,
    realWorldSizeM: material.realWorldSizeM ?? null,
    costPerUnit: material.costPerUnit ?? null,
    unit: material.unit ?? null,
  };
}
