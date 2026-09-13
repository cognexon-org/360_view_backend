export type BuiltinCatalogueQuery = { category?: string; q?: string };

type BuiltinModel = {
  id: string;
  name: string;
  category: string;
  width: number;
  depth: number;
  height: number;
  maxDistanceM?: [number, number, number];
  tags: string[];
};

const ROOT = '/assets/realistic/models';
const CREATED_AT = new Date('2026-09-13T00:00:00.000Z');

const MODELS: BuiltinModel[] = [
  { id: 'sectional_sofa', name: 'Sectional Sofa', category: 'SECTIONAL_SOFA', width: 2.85, depth: 1.515, height: 1.017836, tags: ['premium','living-room','sectional','3-seat','chaise'] },
  { id: 'accent_chair', name: 'Accent Chair', category: 'ACCENT_CHAIR', width: 0.8, depth: 0.783898, height: 0.979803, tags: ['premium','living-room','accent','chair'] },
  { id: 'bar_stool', name: 'Bar Stool', category: 'BAR_STOOL', width: 0.5, depth: 0.457659, height: 1.086446, tags: ['premium','kitchen','bar','stool'] },
  { id: 'king_bed', name: 'King Bed', category: 'KING_BED', width: 1.9675, depth: 2.115, height: 1.15, tags: ['premium','bedroom','king','upholstered'] },
  { id: 'round_dining_table', name: 'Round Dining Table', category: 'ROUND_DINING_TABLE', width: 1.3, depth: 1.3, height: 0.72, tags: ['premium','dining','round','pedestal'] },
  { id: 'side_table', name: 'Side Table', category: 'SIDE_TABLE', width: 0.5, depth: 0.5, height: 0.5575, tags: ['premium','living-room','bedroom','marble'] },
  { id: 'pendant_light', name: 'Pendant Light', category: 'PENDANT_LIGHT', width: 0.56, depth: 0.56, height: 0.975, tags: ['premium','lighting','pendant','metal'] },
  { id: 'kitchen_island', name: 'Kitchen Island', category: 'KITCHEN_ISLAND', width: 1.88, depth: 1.0, height: 0.9375, tags: ['premium','kitchen','island','marble'] },
  { id: 'freestanding_tub', name: 'Freestanding Tub', category: 'FREESTANDING_TUB', width: 1.655, depth: 0.702, height: 0.55, tags: ['premium','bathroom','tub','ceramic'] },
];

function glb(id: string, suffix = ''): string {
  return `${ROOT}/${id}${suffix}.glb`;
}

function visual(model: BuiltinModel) {
  return {
    fit: 'UNIFORM_CONTAIN',
    coordinateSystem: 'Y_UP',
    unit: 'metre',
    lods: [
      { level: 'HIGH', url: glb(model.id), maxDistanceM: 8 },
      { level: 'MEDIUM', url: glb(model.id, '_medium'), maxDistanceM: 16 },
      { level: 'LOW', url: glb(model.id, '_low'), maxDistanceM: 100 },
    ],
    collision: {
      shape: 'BOX',
      boundsM: { width: model.width, depth: model.depth, height: model.height },
      centerM: [0, model.height / 2, 0],
    },
    castShadow: true,
    receiveShadow: true,
    tags: model.tags,
  };
}

export const BUILTIN_CATALOGUE_ASSETS = MODELS.map((model) => ({
  id: `builtin:${model.id}`,
  organizationId: null,
  name: model.name,
  category: model.category,
  glbObjectKey: glb(model.id),
  thumbnailKey: null,
  dimensionsM: { width: model.width, depth: model.depth, height: model.height },
  anchor: null,
  placementRules: null,
  polygonCount: null,
  textureBytes: null,
  metadata: { premium: true, localAssetId: model.id, url: glb(model.id), visual: visual(model) },
  active: true,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
}));

export const BUILTIN_PRODUCTS = MODELS.map((model) => ({
  id: `builtin-product:${model.id}`,
  organizationId: null,
  sku: `PREMIUM-${model.id.toUpperCase()}`,
  name: model.name,
  category: model.category,
  supplier: 'Studio Premium',
  catalogueAssetId: `builtin:${model.id}`,
  metadata: { premium: true, localAssetId: model.id },
  active: true,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  variants: [{
    id: `builtin-variant:${model.id}`,
    productId: `builtin-product:${model.id}`,
    name: 'Default',
    materialId: null,
    price: null,
    currency: null,
    priceVersion: null,
    availability: 'AVAILABLE',
    metadata: { bundled: true },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }],
}));

function matches(query: BuiltinCatalogueQuery, name: string, category: string): boolean {
  if (query.category && query.category !== category) return false;
  if (query.q && !name.toLowerCase().includes(query.q.toLowerCase())) return false;
  return true;
}

export function builtinCatalogueAssets(query: BuiltinCatalogueQuery = {}) {
  return BUILTIN_CATALOGUE_ASSETS.filter((asset) => matches(query, asset.name, asset.category));
}

export function builtinProducts(query: BuiltinCatalogueQuery = {}) {
  return BUILTIN_PRODUCTS.filter((product) => matches(query, product.name, product.category));
}
