import { publicAssetUrl } from './minio.js';

export interface ManifestRoom {
  id: string;
  name: string;
  panorama?: { objectKey: string; metadata?: unknown } | null;
}

export interface ManifestHotspot {
  fromRoomId: string;
  toRoomId: string;
  yaw: number;
  pitch: number;
  label: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function buildTourManifest(params: {
  tourId: string;
  title: string;
  slug: string;
  verificationLabel: string;
  captureDate: Date;
  rooms: ManifestRoom[];
  hotspots: ManifestHotspot[];
  unit: { id: string; label: string; property: { name: string; address: string } };
}) {
  return {
    version: '1.1',
    tourId: params.tourId,
    slug: params.slug,
    title: params.title,
    verificationLabel: params.verificationLabel,
    captureDate: params.captureDate.toISOString(),
    property: {
      name: params.unit.property.name,
      address: params.unit.property.address,
      unitLabel: params.unit.label
    },
    startRoomId: params.rooms[0]?.id ?? null,
    nodes: params.rooms.map((room) => {
      const metadata = record(room.panorama?.metadata);
      const capturePattern = typeof metadata.capturePattern === 'string'
        ? metadata.capturePattern
        : 'IMPORTED_OR_LEGACY';
      const projectionType = typeof metadata.projectionType === 'string'
        ? metadata.projectionType
        : 'EQUIRECTANGULAR_FULL_SPHERE';
      const minPitchDegrees = typeof metadata.minPitchDegrees === 'number'
        ? metadata.minPitchDegrees
        : -90;
      const maxPitchDegrees = typeof metadata.maxPitchDegrees === 'number'
        ? metadata.maxPitchDegrees
        : 90;
      return {
        id: room.id,
        label: room.name,
        panoramaUrl: room.panorama ? publicAssetUrl(room.panorama.objectKey) : null,
        capturePattern,
        projectionType,
        minPitchDegrees,
        maxPitchDegrees
      };
    }),
    hotspots: params.hotspots.map((hotspot) => ({
      from: hotspot.fromRoomId,
      to: hotspot.toRoomId,
      yaw: hotspot.yaw,
      pitch: hotspot.pitch,
      label: hotspot.label
    })),
    fallback: { gallery: true, video: true }
  };
}
