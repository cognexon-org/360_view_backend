import { publicAssetUrl } from './minio.js';

export interface ManifestRoom {
  id: string;
  name: string;
  panorama?: { objectKey: string } | null;
}

export interface ManifestHotspot {
  fromRoomId: string;
  toRoomId: string;
  yaw: number;
  pitch: number;
  label: string;
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
    version: '1.0',
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
    nodes: params.rooms.map((room) => ({
      id: room.id,
      label: room.name,
      panoramaUrl: room.panorama ? publicAssetUrl(room.panorama.objectKey) : null
    })),
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
