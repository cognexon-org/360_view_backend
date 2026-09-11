import { describe, expect, it } from 'vitest';
import { materialTextureContract, signedVisualAsset, visualAssetContract } from '../visual-registry.js';

describe('visual registry', () => {
  it('provides a high LOD and collision bounds when metadata is absent', () => {
    const result = visualAssetContract({ glbObjectKey: 'catalogue/chair.glb', dimensionsM: { width: 0.5, depth: 0.6, height: 0.9 } });
    expect(result.lods[0]).toMatchObject({ level: 'HIGH', objectKey: 'catalogue/chair.glb' });
    expect(result.collision.boundsM).toEqual({ width: 0.5, depth: 0.6, height: 0.9 });
    expect(result.fit).toBe('UNIFORM_CONTAIN');
  });

  it('normalises common PBR texture aliases', () => {
    expect(materialTextureContract({ albedo: 'a.webp', normalMap: 'n.webp', metalness: 'm.webp', occlusion: 'ao.webp' }))
      .toEqual({ baseColor: 'a.webp', normal: 'n.webp', metallic: 'm.webp', ao: 'ao.webp' });
  });

  it('presigns storage object keys without touching external urls', async () => {
    const calls: string[] = [];
    const result = await signedVisualAsset({
      id: 'asset-1', name: 'Chair', category: 'CHAIR', glbObjectKey: 'catalogue/chair.glb', dimensionsM: { width: 0.5, depth: 0.6, height: 0.9 },
      metadata: { visual: { lods: [{ level: 'LOW', objectKey: 'catalogue/chair-low.glb', maxDistanceM: 12 }] } },
    }, async (key) => { calls.push(key); return `https://signed.example/${key}`; });
    expect(calls).toContain('catalogue/chair.glb');
    expect(calls).toContain('catalogue/chair-low.glb');
    expect(result.primaryUrl).toBe('https://signed.example/catalogue/chair.glb');
  });
});
