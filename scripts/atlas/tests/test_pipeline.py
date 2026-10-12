"""Pruebas del pipeline de Atlas. Correr con:  python -m unittest discover scripts/atlas/tests"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import common  # noqa: E402
import import_data  # noqa: E402
import osm_layers  # noqa: E402
import run  # noqa: E402
import update_uf  # noqa: E402
import validate  # noqa: E402


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


class WeeklyScheduleTest(unittest.TestCase):
    """Criterio 12: el job semanal corre el lunes a las 08:00 de Santiago con y sin horario de verano."""

    def test_summer_time_runs_at_11_utc(self):
        # 2026-10-12 es lunes; Chile está en horario de verano (UTC-3) desde septiembre.
        ok, why = run.should_run_weekly(utc(2026, 10, 12, 11, 0), None)
        self.assertTrue(ok, why)
        ok, why = run.should_run_weekly(utc(2026, 10, 12, 12, 0), "2026-10-12T11:00:05Z")
        self.assertFalse(ok, "la segunda ejecución del mismo lunes debe saltarse")

    def test_winter_time_skips_11_utc_and_runs_at_12(self):
        # 2026-06-15 es lunes; horario de invierno (UTC-4): 11:00 UTC son las 07:00.
        ok, why = run.should_run_weekly(utc(2026, 6, 15, 11, 0), None)
        self.assertFalse(ok)
        self.assertIn("08:00", why)
        ok, _ = run.should_run_weekly(utc(2026, 6, 15, 12, 0), None)
        self.assertTrue(ok)

    def test_delayed_cron_still_runs_once(self):
        ok, _ = run.should_run_weekly(utc(2026, 6, 15, 13, 40), "2026-06-08T12:00:00Z")
        self.assertTrue(ok)

    def test_not_monday(self):
        ok, _ = run.should_run_weekly(utc(2026, 10, 13, 11, 0), None)
        self.assertFalse(ok)


class GeometryTest(unittest.TestCase):
    def test_assemble_ring_from_unordered_reversed_ways(self):
        a = [[0, 0], [1, 0]]
        b = [[1, 1], [1, 0]]            # invertido
        c = [[1, 1], [0, 1], [0, 0]]
        rings = osm_layers.assemble_rings([a, c, b])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(len(rings[0]), 5)

    def test_simplify_keeps_corners(self):
        line = [[0, 0], [0.5, 0.00001], [1, 0], [1, 1]]
        out = osm_layers.simplify(line, 0.001)
        self.assertEqual(out, [[0, 0], [1, 0], [1, 1]])

    def test_area_of_100m_square(self):
        # ~100 m × 100 m en Santiago
        dlat, dlon = 100 / 110540, 100 / (111320 * 0.8387)
        ring = [[-70.6, -33.45], [-70.6 + dlon, -33.45], [-70.6 + dlon, -33.45 + dlat], [-70.6, -33.45 + dlat], [-70.6, -33.45]]
        self.assertAlmostEqual(osm_layers.ring_area_m2(ring), 10000, delta=150)

    def test_haversine_2km(self):
        # 2.000 m al norte
        d = osm_layers.haversine_m(-70.6, -33.45, -70.6, -33.45 + 2000 / 111195)
        self.assertAlmostEqual(d, 2000, delta=3)


class ImportTest(unittest.TestCase):
    schema = json.loads((common.CONFIG / "import_schema.json").read_text(encoding="utf-8"))

    def test_parse_chilean_numbers(self):
        self.assertEqual(import_data.parse_number("2.921"), 2921)
        self.assertEqual(import_data.parse_number("2.921,5"), 2921.5)
        self.assertEqual(import_data.parse_number("35,5"), 35.5)
        self.assertEqual(import_data.parse_number("1.250.000"), 1250000)
        self.assertEqual(import_data.parse_number("2,921.5"), 2921.5)

    def test_row_errors_are_reported_by_line_and_column(self):
        row = {"project_id": "x", "project_name": "X", "commune": "Ñuñoa", "unit_id": "101", "bedrooms": "1,5",
               "useful_area_m2": "8", "data_observed_at": "2026-13-01", "publication_url": "no-es-url"}
        _, errs = import_data.validate_row(row, self.schema["projects"]["columns"], 7)
        text = " ".join(errs)
        self.assertIn("fila 7, bedrooms", text)
        self.assertIn("useful_area_m2", text)
        self.assertIn("data_observed_at", text)
        self.assertIn("publication_url", text)

    def test_unknown_stock_is_not_assumed_available(self):
        rows = [{"project_id": "p", "project_name": "P", "commune": "Providencia", "unit_id": "1", "bedrooms": 1,
                 "useful_area_m2": 30, "data_observed_at": "2026-10-01", "delivery_date": "2025-01-01"}]
        p = import_data.build_projects(rows, "2026-10-12T00:00:00Z")["p"]
        self.assertEqual(p["delivery"]["status"], "futura")
        self.assertFalse(p["delivery"]["immediate_verified"])
        self.assertIsNone(p["units"][0]["available"])


class TempDataMixin:
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.patches = [mock.patch.object(m, "DATA", self.tmp) for m in (common, update_uf, validate, import_data)]
        self.patches.append(mock.patch.object(update_uf, "OUT", self.tmp / "uf.json"))
        self.patches.append(mock.patch.object(validate, "SNAP", self.tmp / "snapshots"))
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)


class UfFallbackTest(TempDataMixin, unittest.TestCase):
    """Criterio 10: si el conector falla, se conserva el último dato verificado (nunca un cero)."""

    def test_failure_keeps_last_value_and_marks_stale(self):
        common.write_json(self.tmp / "uf.json", {"value": 41000.5, "date": "2026-10-01", "status": "ok", "series": []})
        with mock.patch.object(update_uf, "from_mindicador", side_effect=RuntimeError("sin red")), \
                mock.patch.object(update_uf, "from_sii", side_effect=RuntimeError("sin red")), \
                mock.patch.dict("os.environ", {"CMF_API_KEY": ""}):
            self.assertEqual(update_uf.main(), 0)
        uf = json.loads((self.tmp / "uf.json").read_text())
        self.assertEqual(uf["value"], 41000.5)
        self.assertEqual(uf["status"], "desactualizado")
        self.assertIn("sin red", uf["last_error"])

    def test_success_picks_latest_value_not_after_today(self):
        today = common.santiago_now().date()
        series = [{"date": "2020-01-01", "value": 28000.0}, {"date": today.isoformat(), "value": 41200.0},
                  {"date": "2099-01-01", "value": 99999.0}]
        with mock.patch.object(update_uf, "from_sii", return_value={"series": series, "source": "t", "source_url": "u"}), \
                mock.patch.dict("os.environ", {"CMF_API_KEY": ""}):
            update_uf.main()
        uf = json.loads((self.tmp / "uf.json").read_text())
        self.assertEqual(uf["value"], 41200.0)


class SiiParserTest(unittest.TestCase):
    def test_month_sections(self):
        html = """<div id="mes_enero"><table><tr><th>1</th><td>39.727,01</td><th>2</th><td>39.731,79</td></tr>
        <tr><th>31</th><td>39.900,10</td><th></th><td></td></tr></table></div>
        <div id="mes_febrero"><table><tr><th>30</th><td>40.000,00</td><th>1</th><td>39.910,55</td></tr></table></div>"""
        out = update_uf.parse_sii(html, 2026)
        self.assertEqual(out[0], {"date": "2026-01-01", "value": 39727.01})
        self.assertIn({"date": "2026-02-01", "value": 39910.55}, out)
        self.assertFalse(any(x["date"].startswith("2026-02-30") for x in out), "30 de febrero no existe")

    def test_classic_grid(self):
        row = "<tr><th>9</th>" + "".join(f"<td>{39000 + m:,.2f}</td>".replace(",", "X").replace(".", ",").replace("X", ".") for m in range(12)) + "</tr>"
        out = update_uf.parse_sii(f"<table>{row}</table>", 2026)
        self.assertEqual(len(out), 12)
        self.assertEqual(out[0], {"date": "2026-01-09", "value": 39000.0})


class ChangesTest(TempDataMixin, unittest.TestCase):
    """Criterio 11: las alertas salen solo ante diferencias verdaderas y guardan antes/después."""

    cfg = {"alerts": {"price_drop_pct": 3, "price_drop_uf": 100}}

    def proj(self, price, date="2027-03"):
        return {"projects": [{"id": "a", "name": "A", "commune": "Ñuñoa", "delivery": {"status": "futura", "date": date},
                              "units": [{"id": "1", "offer_price_uf": price}]}]}

    def test_first_run_creates_baseline_without_alerts(self):
        self.assertEqual(validate.detect_changes(self.proj(3000), {"developments": []}, self.cfg), [])

    def test_rounding_difference_is_ignored_and_real_drop_alerts(self):
        validate.detect_changes(self.proj(3000), {"developments": []}, self.cfg)
        self.assertEqual(validate.detect_changes(self.proj(2999.8), {"developments": []}, self.cfg), [])
        ev = validate.detect_changes(self.proj(2850), {"developments": []}, self.cfg)
        drops = [e for e in ev if e["type"] == "baja_precio"]
        self.assertEqual(len(drops), 1)
        self.assertEqual((drops[0]["before"], drops[0]["after"]), (2999.8, 2850))

    def test_delivery_change_alerts(self):
        validate.detect_changes(self.proj(3000, "2027-03"), {"developments": []}, self.cfg)
        ev = validate.detect_changes(self.proj(3000, "2027-09"), {"developments": []}, self.cfg)
        self.assertEqual([e["type"] for e in ev], ["cambio_entrega"])

    def test_merge_dedupes_same_event(self):
        e = validate.event("baja_precio", "a", "t", 1, 2)
        self.assertEqual(validate.merge_changes([e]), 1)
        self.assertEqual(validate.merge_changes([e]), 0)


if __name__ == "__main__":
    unittest.main()
