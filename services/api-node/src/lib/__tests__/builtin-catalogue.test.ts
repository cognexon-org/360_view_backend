import { describe, expect, it } from 'vitest';
import { builtinCatalogueAssets, builtinProducts } from '../builtin-catalogue.js';

describe('builtin premium catalogue', () => {
  it('exposes the nine bundled premium products and assets', () => {
    expect(builtinCatalogueAssets()).toHaveLength(9);
    expect(builtinProducts()).toHaveLength(9);
  });

  it('uses stable matching ids and LOD urls', () => {
    const asset = builtinCatalogueAssets().find((entry) => entry.id === 'builtin:sectional_sofa');
    const product = builtinProducts().find((entry) => entry.catalogueAssetId === asset?.id);
    expect(product?.name).toBe('Sectional Sofa');
    const visual = asset?.metadata.visual as { lods: Array<{ level: string; url: string }> };
    expect(visual.lods.find((lod) => lod.level === 'LOW')?.url).toBe('/assets/realistic/models/sectional_sofa_low.glb');
  });

  it('honours catalogue filters', () => {
    expect(builtinProducts({ q: 'pendant' })).toHaveLength(1);
    expect(builtinCatalogueAssets({ category: 'KING_BED' })).toHaveLength(1);
  });
});
