from app.processors import exports

MODEL = {
    "rooms": [{
        "id": "living", "name": "Living", "heightM": 2.8,
        "floorPolygon": [[0,0],[4,0],[4,3],[0,3]],
        "walls": [{"id":"w1","start":[0,0],"end":[4,0],"heightM":2.8,"openings":[{"id":"d1","type":"DOOR","offsetM":1,"widthM":0.9,"heightM":2.1}]}],
        "objects": [{"id":"sofa","name":"Sofa","type":"SOFA","size":[2,0.8,0.9],"sku":"S-1"}],
        "measurements": []
    }]
}


def test_svg_and_csv_exports(monkeypatch):
    written = {}
    monkeypatch.setattr(exports, "put_bytes", lambda bucket, key, data, mime: written.update({"bucket":bucket,"key":key,"data":data,"mime":mime}))
    svg = exports.export_artifact({"model":MODEL,"format":"SVG","outputBucket":"private","outputKey":"plan.svg"})
    assert svg["mimeType"] == "image/svg+xml"
    assert b"Living" in written["data"]
    csv = exports.export_artifact({"model":MODEL,"format":"DOOR_WINDOW_SCHEDULE","outputBucket":"private","outputKey":"openings.csv"})
    assert csv["mimeType"] == "text/csv"
    assert b"d1" in written["data"]


def test_model_qa_blocks_invalid_opening():
    from app.processors.modeb_pipeline import validate_model
    invalid = {"rooms":[{**MODEL["rooms"][0], "walls":[{"id":"w1","start":[0,0],"end":[1,0],"openings":[{"id":"d1","offsetM":0.5,"widthM":0.9,"heightM":2.1}]}]}]}
    report = validate_model({"model":invalid})
    assert report["valid"] is False
    assert any(issue["code"] == "OPENING_OUTSIDE_WALL" for issue in report["issues"])


def test_render_falls_back_without_blender(monkeypatch):
    from app.processors import render
    written = {}
    monkeypatch.setattr(render.shutil, 'which', lambda _name: None)
    monkeypatch.setattr(render, 'put_bytes', lambda bucket, key, data, mime: written.update({'data':data,'mime':mime}))
    result = render.render_scene({'model':MODEL,'outputBucket':'private','outputKey':'render.png','settings':{'width':800,'height':600}})
    assert result['renderMode'] == 'FLOORPLAN_FALLBACK'
    assert result['mimeType'] == 'image/png'
    assert written['data'].startswith(b'\x89PNG')
