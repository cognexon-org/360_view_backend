from __future__ import annotations

from typing import Any

BOUNDARY = "PROPOSED_AI_OBSERVATION"
DISCLAIMER = (
    "ProgressionAi Progress Intelligence v1 creates review candidates from bounded difference-region evidence. "
    "It does not certify construction quality, structural safety, code compliance, contractual progress, or payment milestones. "
    "Authorised human review remains authoritative."
)

ALLOWED_CHANGE_TYPES = {
    "ADDED",
    "REMOVED",
    "MOVED",
    "SURFACE_CHANGED",
    "APPEARANCE_CHANGED",
    "GEOMETRY_CHANGED",
    "UNCERTAIN",
}

ALLOWED_SEMANTICS = {
    "WALL",
    "PARTITION_WALL",
    "FLOORING",
    "CEILING",
    "DOOR",
    "WINDOW",
    "ELECTRICAL",
    "PLUMBING",
    "FIXTURE",
    "FURNITURE",
    "SURFACE",
    "OPENING",
    "UNKNOWN",
}


def _bounded(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(0.0, min(1.0, number))


def _observation_type(change_type: str, semantic: str) -> tuple[str, str]:
    if semantic in {"WALL", "PARTITION_WALL"} and change_type == "ADDED":
        return "POSSIBLE_PARTITION_INSTALLED", "Partition/wall-like addition detected"
    if semantic in {"WALL", "PARTITION_WALL"} and change_type == "REMOVED":
        return "POSSIBLE_PARTITION_REMOVED", "Partition/wall-like removal detected"
    if semantic == "FLOORING" and change_type in {"ADDED", "SURFACE_CHANGED", "APPEARANCE_CHANGED"}:
        return "POSSIBLE_FLOOR_FINISH_CHANGE", "Floor finish appears changed"
    if semantic == "CEILING" and change_type in {"ADDED", "SURFACE_CHANGED", "APPEARANCE_CHANGED", "GEOMETRY_CHANGED"}:
        return "POSSIBLE_CEILING_CHANGE", "Ceiling region appears changed"
    if semantic in {"DOOR", "WINDOW", "OPENING"} and change_type in {"ADDED", "REMOVED", "MOVED", "GEOMETRY_CHANGED"}:
        return "POSSIBLE_OPENING_CHANGE", "Door/window opening appears changed"
    if semantic == "ELECTRICAL" and change_type == "ADDED":
        return "POSSIBLE_ELECTRICAL_ITEM_ADDED", "Electrical item appears added"
    if semantic in {"PLUMBING", "FIXTURE"} and change_type == "ADDED":
        return "POSSIBLE_FIXTURE_ADDED", "Fixture appears added"
    if change_type == "ADDED":
        return "POSSIBLE_ADDITION", "New region appears present"
    if change_type == "REMOVED":
        return "POSSIBLE_REMOVAL", "Previously visible region appears absent"
    if change_type == "MOVED":
        return "POSSIBLE_RELOCATION", "Region appears spatially relocated"
    if change_type in {"SURFACE_CHANGED", "APPEARANCE_CHANGED"}:
        return "POSSIBLE_SURFACE_CHANGE", "Surface appearance appears changed"
    if change_type == "GEOMETRY_CHANGED":
        return "POSSIBLE_GEOMETRY_CHANGE", "Spatial geometry appears changed"
    return "UNCERTAIN_CHANGE", "Change evidence is uncertain"


def analyze_progress(payload: dict[str, Any]) -> dict[str, Any]:
    registration = payload.get("registration") or {}
    if str(registration.get("status", "")).upper() != "VERIFIED":
        raise ValueError("Progress intelligence requires a human-verified registration")

    registration_confidence = _bounded(registration.get("confidence"), 0.0)
    regions = payload.get("regions") or []
    if not isinstance(regions, list) or not regions:
        raise ValueError("At least one deterministic difference region is required")

    policy = payload.get("policy") or {}
    min_confidence = _bounded(policy.get("minConfidence"), 0.55)
    include_uncertain = bool(policy.get("includeUncertainRegions", False))
    policy_version = str(payload.get("policyVersion") or "progress-policy-v1")
    model_version = str(payload.get("modelVersion") or "bounded-taxonomy-v1")
    engine_version = str(payload.get("engineVersion") or "progress-intelligence-v1")

    observations: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for index, raw in enumerate(regions):
        if not isinstance(raw, dict):
            skipped.append({"regionId": f"region-{index+1}", "reason": "INVALID_REGION"})
            continue

        region_id = str(raw.get("id") or f"region-{index+1}")
        change_type = str(raw.get("changeType") or "UNCERTAIN").upper()
        semantic = str(raw.get("semanticHint") or "UNKNOWN").upper()
        if change_type not in ALLOWED_CHANGE_TYPES:
            skipped.append({"regionId": region_id, "reason": "UNSUPPORTED_CHANGE_TYPE", "value": change_type})
            continue
        if semantic not in ALLOWED_SEMANTICS:
            semantic = "UNKNOWN"

        if change_type == "UNCERTAIN" and not include_uncertain:
            skipped.append({"regionId": region_id, "reason": "UNCERTAIN_REGION_POLICY"})
            continue

        geometric = _bounded(raw.get("geometricConfidence"), 0.70)
        semantic_conf = _bounded(raw.get("semanticConfidence"), 0.65 if semantic != "UNKNOWN" else 0.50)
        semantic_penalty = 0.78 if semantic == "UNKNOWN" else 1.0
        confidence = min(registration_confidence, geometric, semantic_conf) * semantic_penalty
        confidence = round(max(0.0, min(1.0, confidence)), 6)

        uncertainty: list[str] = []
        if registration_confidence < 0.75:
            uncertainty.append("Registration confidence is below 0.75")
        if geometric < 0.75:
            uncertainty.append("Difference-region geometric confidence is below 0.75")
        if semantic == "UNKNOWN":
            uncertainty.append("No bounded semantic label was supplied")
        elif semantic_conf < 0.75:
            uncertainty.append("Semantic confidence is below 0.75")

        if confidence < min_confidence:
            skipped.append({
                "regionId": region_id,
                "reason": "BELOW_CONFIDENCE_THRESHOLD",
                "confidence": confidence,
                "threshold": min_confidence,
                "uncertaintyReasons": uncertainty,
            })
            continue

        observation_type, title = _observation_type(change_type, semantic)
        evidence_refs = raw.get("evidenceRefs") if isinstance(raw.get("evidenceRefs"), list) else []
        spatial_ref = raw.get("spatialRef") if isinstance(raw.get("spatialRef"), dict) else {"regionId": region_id}
        magnitude = raw.get("magnitude") if isinstance(raw.get("magnitude"), dict) else {}

        observations.append({
            "observationType": observation_type,
            "title": title,
            "spatialRef": spatial_ref,
            "confidence": confidence,
            "modelVersion": model_version,
            "policyVersion": policy_version,
            "structuredEvidence": {
                "schemaVersion": 1,
                "boundary": BOUNDARY,
                "regionId": region_id,
                "changeType": change_type,
                "semanticHint": semantic,
                "signals": {
                    "registrationConfidence": registration_confidence,
                    "geometricConfidence": geometric,
                    "semanticConfidence": semantic_conf,
                    "magnitude": magnitude,
                },
                "evidenceRefs": [str(item) for item in evidence_refs[:20]],
                "uncertaintyReasons": uncertainty,
                "disclaimer": DISCLAIMER,
            },
        })

    return {
        "schemaVersion": 1,
        "boundary": BOUNDARY,
        "engineVersion": engine_version,
        "modelVersion": model_version,
        "policyVersion": policy_version,
        "registration": {
            "id": registration.get("id"),
            "confidence": registration_confidence,
            "method": registration.get("method"),
            "status": registration.get("status"),
        },
        "observations": observations,
        "diagnostics": {
            "inputRegionCount": len(regions),
            "observationCount": len(observations),
            "skippedRegionCount": len(skipped),
            "skippedRegions": skipped,
            "minConfidence": min_confidence,
            "includeUncertainRegions": include_uncertain,
        },
        "disclaimer": DISCLAIMER,
    }
