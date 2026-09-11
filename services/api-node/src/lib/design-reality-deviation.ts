export type Point2 = [number, number];

export interface RoomGeometryLike {
  id?: string;
  name?: string;
  floorPolygon: Point2[];
  heightM?: number | null;
}

export interface RealityRoomGeometryLike {
  id?: string;
  name?: string;
  floorPolygon: Point2[];
  ceilingHeightM?: number | null;
}

export interface DeviationTolerance {
  boundaryM: number;
  areaRatio: number;
  ceilingHeightM: number;
}

export interface DeviationCandidate {
  kind: 'BOUNDARY_OFFSET' | 'AREA_DIFFERENCE' | 'CEILING_HEIGHT_DIFFERENCE';
  magnitude: number;
  unit: 'm' | 'ratio';
  tolerance: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  title: string;
  description: string;
  spatialRef: Record<string, unknown>;
  evidence: Record<string, unknown>;
}

export interface DesignRealityDeviationReport {
  schemaVersion: 1;
  boundary: 'DETERMINISTIC_GEOMETRY_ONLY';
  disclaimer: string;
  engineVersion: string;
  designRoom: { id?: string; name?: string };
  realityRoom: { id?: string; name?: string };
  tolerances: DeviationTolerance;
  metrics: {
    boundary: { meanM: number; p95M: number; maxM: number; sampleCount: number };
    area: { designM2: number; realityM2: number; deltaM2: number; deltaRatio: number };
    ceilingHeight?: { designM: number; realityM: number; deltaM: number };
  };
  overlay: { transformedDesignPolygon: Point2[]; realityPolygon: Point2[] };
  deviations: DeviationCandidate[];
}

const DEFAULT_TOLERANCE: DeviationTolerance = { boundaryM: 0.05, areaRatio: 0.03, ceilingHeightM: 0.03 };

function finitePoint(value: unknown): value is Point2 {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]));
}

export function parsePolygon(value: unknown): Point2[] {
  if (!Array.isArray(value)) return [];
  return value.filter(finitePoint).map((p) => [Number(p[0]), Number(p[1])]);
}

function polygonArea(points: Point2[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function pointSegmentDistance(point: Point2, a: Point2, b: Point2): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = point[0] - a[0];
  const wy = point[1] - a[1];
  const length2 = vx * vx + vy * vy;
  if (length2 <= 1e-12) return Math.hypot(wx, wy);
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / length2));
  const px = a[0] + t * vx;
  const py = a[1] + t * vy;
  return Math.hypot(point[0] - px, point[1] - py);
}

function distanceToBoundary(point: Point2, polygon: Point2[]): number {
  if (polygon.length < 2) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i += 1) {
    best = Math.min(best, pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
  }
  return best;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function matrix4(value: unknown): number[][] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((row) => !Array.isArray(row) || row.length !== 4)) {
    throw new Error('Alignment transform must contain a 4x4 matrix');
  }
  return (value as unknown[][]).map((row) => row.map((cell) => Number(cell)));
}

/**
 * Studio floor polygons are X/Z plan coordinates. Registration uses XYZ anchors,
 * so a 2D plan point [x,z] is lifted to [x,0,z,1] before applying design->reality.
 */
export function transformPlanPoint(point: Point2, transform: Record<string, unknown>): Point2 {
  const matrix = matrix4(transform.matrix4);
  const vector = [point[0], 0, point[1], 1];
  const out = matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
  if (!Number.isFinite(out[0]) || !Number.isFinite(out[2])) throw new Error('Alignment transform produced a non-finite point');
  return [out[0], out[2]];
}

function severity(value: number, tolerance: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  const ratio = tolerance > 0 ? value / tolerance : Number.POSITIVE_INFINITY;
  if (ratio >= 3) return 'HIGH';
  if (ratio >= 1.75) return 'MEDIUM';
  return 'LOW';
}

export function buildDesignRealityDeviationReport(args: {
  designRoom: RoomGeometryLike;
  realityRoom: RealityRoomGeometryLike;
  transform: Record<string, unknown>;
  tolerances?: Partial<DeviationTolerance>;
  engineVersion?: string;
}): DesignRealityDeviationReport {
  const tolerances = { ...DEFAULT_TOLERANCE, ...(args.tolerances ?? {}) };
  const designPolygon = parsePolygon(args.designRoom.floorPolygon);
  const realityPolygon = parsePolygon(args.realityRoom.floorPolygon);
  if (designPolygon.length < 3) throw new Error('Design room does not contain a usable floor polygon');
  if (realityPolygon.length < 3) throw new Error('Reality room does not contain a usable floor polygon');

  const transformedDesign = designPolygon.map((point) => transformPlanPoint(point, args.transform));
  const distances = [
    ...transformedDesign.map((point) => distanceToBoundary(point, realityPolygon)),
    ...realityPolygon.map((point) => distanceToBoundary(point, transformedDesign))
  ].filter(Number.isFinite);

  const meanM = distances.reduce((sum, value) => sum + value, 0) / Math.max(1, distances.length);
  const p95M = percentile(distances, 0.95);
  const maxM = Math.max(...distances, 0);
  const designM2 = polygonArea(transformedDesign);
  const realityM2 = polygonArea(realityPolygon);
  const deltaM2 = realityM2 - designM2;
  const deltaRatio = designM2 > 1e-9 ? Math.abs(deltaM2) / designM2 : 0;

  const deviations: DeviationCandidate[] = [];
  if (maxM > tolerances.boundaryM) {
    deviations.push({
      kind: 'BOUNDARY_OFFSET', magnitude: round(maxM), unit: 'm', tolerance: tolerances.boundaryM,
      severity: severity(maxM, tolerances.boundaryM),
      title: `Room boundary differs by up to ${Math.round(maxM * 1000)} mm`,
      description: 'Aligned floor-plan boundaries exceed the configured spatial review tolerance. This is a geometric observation, not an engineering non-conformance.',
      spatialRef: { type: 'ROOM_BOUNDARY' },
      evidence: { meanM: round(meanM), p95M: round(p95M), maxM: round(maxM), sampleCount: distances.length }
    });
  }
  if (deltaRatio > tolerances.areaRatio) {
    deviations.push({
      kind: 'AREA_DIFFERENCE', magnitude: round(deltaRatio), unit: 'ratio', tolerance: tolerances.areaRatio,
      severity: severity(deltaRatio, tolerances.areaRatio),
      title: `Measured room area differs by ${Math.round(deltaRatio * 1000) / 10}%`,
      description: 'The aligned reality footprint area differs from the selected design version beyond the configured review tolerance.',
      spatialRef: { type: 'ROOM_AREA' },
      evidence: { designM2: round(designM2), realityM2: round(realityM2), deltaM2: round(deltaM2), deltaRatio: round(deltaRatio) }
    });
  }

  const designHeight = Number(args.designRoom.heightM);
  const realityHeight = Number(args.realityRoom.ceilingHeightM);
  let ceilingHeight: DesignRealityDeviationReport['metrics']['ceilingHeight'];
  if (Number.isFinite(designHeight) && Number.isFinite(realityHeight) && designHeight > 0 && realityHeight > 0) {
    const deltaM = realityHeight - designHeight;
    ceilingHeight = { designM: round(designHeight), realityM: round(realityHeight), deltaM: round(deltaM) };
    if (Math.abs(deltaM) > tolerances.ceilingHeightM) {
      deviations.push({
        kind: 'CEILING_HEIGHT_DIFFERENCE', magnitude: round(Math.abs(deltaM)), unit: 'm', tolerance: tolerances.ceilingHeightM,
        severity: severity(Math.abs(deltaM), tolerances.ceilingHeightM),
        title: `Ceiling height differs by ${Math.round(Math.abs(deltaM) * 1000)} mm`,
        description: 'Design and captured ceiling height differ beyond the configured review tolerance.',
        spatialRef: { type: 'ROOM_CEILING' },
        evidence: ceilingHeight
      });
    }
  }

  return {
    schemaVersion: 1,
    boundary: 'DETERMINISTIC_GEOMETRY_ONLY',
    disclaimer: 'Design ↔ Reality v1 compares selected, aligned room geometry only. It does not certify construction quality, compliance, structural safety or contractual deviation. Human review remains authoritative.',
    engineVersion: args.engineVersion ?? 'design-reality-v1',
    designRoom: { id: args.designRoom.id, name: args.designRoom.name },
    realityRoom: { id: args.realityRoom.id, name: args.realityRoom.name },
    tolerances,
    metrics: {
      boundary: { meanM: round(meanM), p95M: round(p95M), maxM: round(maxM), sampleCount: distances.length },
      area: { designM2: round(designM2), realityM2: round(realityM2), deltaM2: round(deltaM2), deltaRatio: round(deltaRatio) },
      ...(ceilingHeight ? { ceilingHeight } : {})
    },
    overlay: { transformedDesignPolygon: transformedDesign.map(([x, y]) => [round(x), round(y)]), realityPolygon: realityPolygon.map(([x, y]) => [round(x), round(y)]) },
    deviations
  };
}
