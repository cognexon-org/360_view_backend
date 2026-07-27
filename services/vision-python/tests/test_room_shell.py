from app.processors.room_shell import _wall_meshes


def test_wall_with_door_generates_segments():
    meshes = _wall_meshes({
        "id": "wall-1",
        "start": [0, 0],
        "end": [4, 0],
        "thicknessM": 0.12,
        "openings": [{
            "id": "door-1",
            "type": "DOOR",
            "offsetM": 1.0,
            "widthM": 0.9,
            "heightM": 2.1,
            "bottomM": 0,
        }],
    }, 2.8)
    assert len(meshes) == 3
