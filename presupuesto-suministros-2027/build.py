"""Genera index.html con una copia (snapshot) de la base Presupuesto_2027-Afta.xlsm.

Uso:  python3 build.py <ruta/Presupuesto_2027-Afta.xlsm>

El script sólo copia los valores de las hojas usadas (SUM 2027, Presupuesto 2026,
Proyección de Gastos) dentro del HTML. Toda la limpieza y los cálculos los hace el
propio dashboard en el navegador, con el mismo código que usa el botón
"Actualizar desde Drive" y "Cargar Excel": una sola lógica para las tres fuentes.
"""
import datetime as dt
import json
import sys
import warnings
from pathlib import Path

import openpyxl

warnings.filterwarnings("ignore")
HERE = Path(__file__).parent
SHEETS = ["SUM 2027", "Presupuesto 2026", "Proyección de Gastos"]


def cell(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()[:10]
    if isinstance(v, str) and v.startswith("#"):
        return None  # #REF!, #N/A, ...
    return v


def main(xlsm):
    wb = openpyxl.load_workbook(xlsm, data_only=True, read_only=True)
    sheets = {}
    for name in SHEETS:
        rows = []
        for i, r in enumerate(wb[name].iter_rows(values_only=True), start=1):
            vals = [cell(v) for v in r]
            while vals and vals[-1] is None:
                vals.pop()
            if vals:
                rows.append([i, vals])
        sheets[name] = rows
    raw = dict(source=Path(xlsm).name, origin="snapshot",
               loadedAt=dt.datetime.now().isoformat(timespec="minutes"), sheets=sheets)
    tpl = (HERE / "template.html").read_text(encoding="utf-8")
    out = tpl.replace("/*__RAW__*/null", json.dumps(raw, ensure_ascii=False, separators=(",", ":")))
    (HERE / "index.html").write_text(out, encoding="utf-8")
    print("OK:", {k: len(v) for k, v in sheets.items()})


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Presupuesto_2027-Afta.xlsm")
