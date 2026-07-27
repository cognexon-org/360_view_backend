from app.processors.capture_validation import validate_capture


def test_connected_property_tour_is_ready():
    output = validate_capture({
        "mode": "PROPERTY_TOUR",
        "rooms": [
            {"id": "a", "name": "Entry", "panoramaStatus": "APPROVED"},
            {"id": "b", "name": "Living", "panoramaStatus": "APPROVED"},
        ],
        "connections": [{"fromRoomId": "a", "toRoomId": "b"}],
        "assetKinds": ["PANORAMA"],
    })
    assert output["ready"] is True


def test_disconnected_property_tour_requests_recapture():
    output = validate_capture({
        "mode": "PROPERTY_TOUR",
        "rooms": [
            {"id": "a", "name": "Entry", "panoramaStatus": "APPROVED"},
            {"id": "b", "name": "Living", "panoramaStatus": "APPROVED"},
        ],
        "connections": [],
        "assetKinds": ["PANORAMA"],
    })
    assert output["ready"] is False
    assert any(issue["code"] == "room_graph_disconnected" for issue in output["issues"])
