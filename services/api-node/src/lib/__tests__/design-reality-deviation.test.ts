import { describe, expect, it } from 'vitest';
import { buildDesignRealityDeviationReport } from '../design-reality-deviation.js';

const identity = { matrix4: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] };

describe('design reality deviation v1', () => {
  it('reports no deviation for matching geometry', () => {
    const report = buildDesignRealityDeviationReport({
      designRoom: { id: 'd1', name: 'Living', heightM: 2.8, floorPolygon: [[0,0],[4,0],[4,3],[0,3]] },
      realityRoom: { id: 'r1', name: 'Living', ceilingHeightM: 2.8, floorPolygon: [[0,0],[4,0],[4,3],[0,3]] },
      transform: identity
    });
    expect(report.metrics.boundary.maxM).toBe(0);
    expect(report.metrics.area.deltaRatio).toBe(0);
    expect(report.deviations).toHaveLength(0);
  });

  it('flags a shifted wall / area difference after alignment', () => {
    const report = buildDesignRealityDeviationReport({
      designRoom: { heightM: 2.8, floorPolygon: [[0,0],[4,0],[4,3],[0,3]] },
      realityRoom: { ceilingHeightM: 2.9, floorPolygon: [[0,0],[4.2,0],[4.2,3],[0,3]] },
      transform: identity
    });
    expect(report.metrics.boundary.maxM).toBeCloseTo(0.2, 4);
    expect(report.deviations.map((row) => row.kind)).toContain('BOUNDARY_OFFSET');
    expect(report.deviations.map((row) => row.kind)).toContain('AREA_DIFFERENCE');
    expect(report.deviations.map((row) => row.kind)).toContain('CEILING_HEIGHT_DIFFERENCE');
  });

  it('applies the registered design-to-reality transform', () => {
    const report = buildDesignRealityDeviationReport({
      designRoom: { heightM: 2.8, floorPolygon: [[0,0],[4,0],[4,3],[0,3]] },
      realityRoom: { ceilingHeightM: 2.8, floorPolygon: [[10,5],[14,5],[14,8],[10,8]] },
      transform: { matrix4: [[1,0,0,10],[0,1,0,0],[0,0,1,5],[0,0,0,1]] }
    });
    expect(report.metrics.boundary.maxM).toBe(0);
    expect(report.deviations).toHaveLength(0);
  });
});
