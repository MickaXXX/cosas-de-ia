"""Escala y validación dimensional.

- Factor de escala uniforme: s = D/d con una referencia; con varias, mínimos cuadrados s = Σ D·d / Σ d².
  Ajustar la escala no corrige deformaciones de la reconstrucción.
- Las comprobaciones (medidas reservadas) nunca participan en el ajuste.
- Estados: sin calibrar → calibrado sin verificar → verificado para la tolerancia registrada.
"""
import math

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import get_settings
from .models import CalibrationReference, ModelVersion, ScaleState, ValidationCheck

UNIT_TO_M = {"m": 1.0, "cm": 0.01, "mm": 0.001, "in": 0.0254, "ft": 0.3048}
MIN_MODEL_DISTANCE = 1e-9


def to_meters(value: float, unit: str) -> float:
    return value * UNIT_TO_M[unit]


def dist(a, b) -> float:
    return math.dist(a, b)


def fit_scale(refs) -> float | None:
    pairs = [(r.real_distance_m, dist(r.point_a, r.point_b)) for r in refs]
    pairs = [(D, d) for D, d in pairs if d > MIN_MODEL_DISTANCE]
    if not pairs:
        return None
    return sum(D * d for D, d in pairs) / sum(d * d for _, d in pairs)


def same_segment(a1, b1, a2, b2, eps: float) -> bool:
    return (dist(a1, a2) < eps and dist(b1, b2) < eps) or (dist(a1, b2) < eps and dist(b1, a2) < eps)


def check_passes(abs_err: float, rel_err: float, tol_abs: float | None, tol_rel: float | None) -> bool | None:
    """Una comprobación pasa si cumple todas las tolerancias registradas (absoluta y/o relativa)."""
    if tol_abs is None and tol_rel is None:
        return None
    ok = True
    if tol_abs is not None:
        ok = ok and abs(abs_err) <= tol_abs
    if tol_rel is not None:
        ok = ok and abs(rel_err) <= tol_rel
    return ok


def evaluate(db: Session, mv: ModelVersion) -> dict:
    refs = list(db.scalars(select(CalibrationReference)
                           .where(CalibrationReference.model_version_id == mv.id)
                           .order_by(CalibrationReference.created_at)))
    checks = list(db.scalars(select(ValidationCheck)
                             .where(ValidationCheck.model_version_id == mv.id)
                             .order_by(ValidationCheck.created_at)))
    s = fit_scale(refs)

    def row(obj, is_check: bool) -> dict:
        d = dist(obj.point_a, obj.point_b)
        out = {"obj": obj, "model_distance": d}
        if s is not None:
            scaled = s * d
            abs_err = scaled - obj.real_distance_m
            rel = abs_err / obj.real_distance_m
            out.update(scaled_distance_m=scaled, abs_error_m=abs_err, rel_error=rel)
            if is_check:
                out["within_tolerance"] = check_passes(abs_err, rel, mv.tolerance_abs_m, mv.tolerance_rel)
        return out

    ref_rows = [row(r, False) for r in refs]
    chk_rows = [row(c, True) for c in checks]
    evaluated = [c for c in chk_rows if "abs_error_m" in c]

    min_checks = get_settings().min_validation_checks
    has_tol = mv.tolerance_abs_m is not None or mv.tolerance_rel is not None
    if s is None:
        state = ScaleState.uncalibrated
    elif len(evaluated) >= min_checks and has_tol and all(c["within_tolerance"] for c in evaluated):
        state = ScaleState.verified
    else:
        state = ScaleState.calibrated_unverified

    method = None
    if s is not None:
        method = ("Factor uniforme con una referencia (D/d)" if len(refs) == 1
                  else f"Factor uniforme por mínimos cuadrados con {len(refs)} referencias")

    abs_errs = [abs(c["abs_error_m"]) for c in evaluated]
    rel_errs = [abs(c["rel_error"]) for c in evaluated]
    if state == ScaleState.uncalibrated:
        notice = "Sin calibrar: las distancias están en unidades arbitrarias del modelo; no son metros."
    elif state == ScaleState.calibrated_unverified:
        faltan = max(0, min_checks - len(evaluated))
        motivos = []
        if faltan:
            motivos.append(f"faltan {faltan} comprobación(es) independiente(s)")
        if not has_tol:
            motivos.append("no hay tolerancia registrada")
        if evaluated and has_tol and not all(c["within_tolerance"] for c in evaluated):
            motivos.append("hay comprobaciones fuera de tolerancia")
        notice = ("Calibrado sin verificar: las medidas en metros son estimaciones"
                  + (f" ({'; '.join(motivos)})." if motivos else "."))
    else:
        notice = (f"Verificado para la tolerancia registrada con {len(evaluated)} comprobaciones. "
                  "Las medidas siguen siendo estimaciones y no aplican a zonas sin geometría observada.")
    return {
        "scale_factor": s,
        "scale_state": state,
        "method": method,
        "reference_rows": ref_rows,
        "check_rows": chk_rows,
        "n_checks": len(evaluated),
        "min_checks_required": min_checks,
        "max_abs_error_m": max(abs_errs) if abs_errs else None,
        "max_rel_error": max(rel_errs) if rel_errs else None,
        "rms_error_m": math.sqrt(sum(e * e for e in abs_errs) / len(abs_errs)) if abs_errs else None,
        "notice": notice,
    }


def apply(db: Session, mv: ModelVersion) -> dict:
    """Recalcula y persiste el factor y el estado de escala de la versión."""
    ev = evaluate(db, mv)
    mv.scale_factor = ev["scale_factor"]
    mv.scale_state = ev["scale_state"]
    mv.scale_method = ev["method"]
    db.commit()
    return ev
