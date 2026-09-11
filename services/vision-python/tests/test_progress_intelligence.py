from app.processors.progress_intelligence import analyze_progress


def base_payload():
    return {
        "registration": {"id": "reg-1", "status": "VERIFIED", "confidence": 0.92, "method": "ANCHOR_RIGID"},
        "engineVersion": "progress-intelligence-v1",
        "modelVersion": "bounded-taxonomy-v1",
        "policyVersion": "progress-policy-v1",
        "policy": {"minConfidence": 0.55, "includeUncertainRegions": False},
    }


def test_partition_addition_is_proposed_not_certified():
    payload = base_payload()
    payload["regions"] = [{
        "id": "r1", "changeType": "ADDED", "semanticHint": "PARTITION_WALL",
        "geometricConfidence": 0.90, "semanticConfidence": 0.88,
        "evidenceRefs": ["snapshot:a", "snapshot:b"],
    }]
    result = analyze_progress(payload)
    assert result["boundary"] == "PROPOSED_AI_OBSERVATION"
    assert result["observations"][0]["observationType"] == "POSSIBLE_PARTITION_INSTALLED"
    assert result["observations"][0]["confidence"] == 0.88
    assert "certif" not in result["observations"][0]["title"].lower()


def test_low_confidence_region_is_skipped():
    payload = base_payload()
    payload["regions"] = [{
        "id": "r-low", "changeType": "SURFACE_CHANGED", "semanticHint": "FLOORING",
        "geometricConfidence": 0.41, "semanticConfidence": 0.93,
    }]
    result = analyze_progress(payload)
    assert result["observations"] == []
    assert result["diagnostics"]["skippedRegions"][0]["reason"] == "BELOW_CONFIDENCE_THRESHOLD"


def test_registration_must_be_verified():
    payload = base_payload()
    payload["registration"]["status"] = "PROPOSED"
    payload["regions"] = [{"id": "r1", "changeType": "ADDED"}]
    try:
        analyze_progress(payload)
        assert False, "expected ValueError"
    except ValueError as exc:
        assert "verified registration" in str(exc)
