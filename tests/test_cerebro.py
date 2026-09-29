"""Pruebas del cerebro: python -m unittest discover tests"""
import json
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from cerebro import anatomia, corteza, memoria, reflejos
from cerebro import __main__ as cli

CODIGO = textwrap.dedent('''
    import numpy as np
    import pandas as pd

    def costo(h, d, R):
        return d * R

    def total(df):
        def fila(r):
            d = r["d"]
            c = costo(1, d, 2)
            return c
        df["c"] = df.apply(fila, axis=1)
        for i in range(3):
            x = df.copy()
        return df

    resultado = total(pd.DataFrame({"d": np.arange(3)}))
''')


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.raiz = Path(self.tmp.name)
        (self.raiz / "src").mkdir()
        (self.raiz / "src" / "m.py").write_text(CODIGO)
        self.anat = anatomia.escanear(["src"], raiz=self.raiz)
        self.cfg = {"id": "t", **memoria.DEFAULTS, "rutas": ["src"]}
        p = mock.patch.object(memoria, "DIR", self.raiz / "cerebro")
        p.start(); self.addCleanup(p.stop)
        self.mem = memoria.Memoria(self.cfg)
        self.mem.sincronizar(self.anat)

    def tearDown(self):
        self.tmp.cleanup()

    def nid(self, qual):
        return f"src/m.py::{qual}"


class TestAnatomia(Base):
    def test_neuronas_y_sinapsis(self):
        ns = self.anat.neuronas
        self.assertEqual(set(ns), {self.nid(q) for q in ("costo", "total", "total.fila", "<principal>")})
        self.assertEqual(ns[self.nid("total.fila")].tipo, "anidada")
        self.assertIn(self.nid("total.fila"), ns[self.nid("total")].llama)     # pasada a apply
        self.assertEqual(ns[self.nid("total.fila")].llama, [self.nid("costo")])
        self.assertEqual(ns[self.nid("<principal>")].llama, [self.nid("total")])
        self.assertIn("pandas", ns[self.nid("<principal>")].libs)

    def test_huella_ignora_comentarios(self):
        (self.raiz / "src" / "m.py").write_text(CODIGO.replace("return d * R", "return d * R  # comentario"))
        otra = anatomia.escanear(["src"], raiz=self.raiz)
        self.assertEqual(otra.neuronas[self.nid("costo")].hash, self.anat.neuronas[self.nid("costo")].hash)

    def test_codigo_compacto_colapsa_hijas(self):
        txt = corteza.codigo_compacto(self.anat.neuronas[self.nid("total")], self.anat)
        self.assertIn("neurona aparte: total.fila", txt)
        self.assertNotIn('r["d"]', txt)
        self.assertIn('r["d"]', corteza.codigo_compacto(self.anat.neuronas[self.nid("total")], self.anat, min_lineas=10))


class TestReflejos(Base):
    def reglas(self, qual):
        return {m["regla"] for m in reflejos.revisar(self.anat.neuronas[self.nid(qual)])}

    def test_detecta(self):
        self.assertIn("param_sin_uso", self.reglas("costo"))
        self.assertTrue({"apply_axis1", "copia_en_bucle"} <= self.reglas("total"))

    def test_reflejo_corregido_pasa_a_aplicada(self):
        self.mem.aplicar_reflejos(self.anat, {n: reflejos.revisar(x) for n, x in self.anat.neuronas.items()})
        (self.raiz / "src" / "m.py").write_text(CODIGO.replace("def costo(h, d, R):", "def costo(d, R):")
                                                 .replace("costo(1, d", "costo(d"))
        anat2 = anatomia.escanear(["src"], raiz=self.raiz)
        self.mem.sincronizar(anat2)
        self.mem.aplicar_reflejos(anat2, {n: reflejos.revisar(x) for n, x in anat2.neuronas.items()})
        m = next(m for m in self.mem.mejoras_de(self.nid("costo")) if m["regla"] == "param_sin_uso")
        self.assertEqual(m["estado"], "aplicada")


class TestMemoria(Base):
    def test_dedup_y_decision_y_lecciones(self):
        m = {"titulo": "Vectorizar el cálculo de costos", "categoria": "rendimiento"}
        a = self.mem.agregar(self.nid("total"), m, "claude", "h")
        self.assertIsNotNone(a)
        self.assertIsNone(self.mem.agregar(self.nid("total"), {**m, "titulo": "vectorizar el calculo de costos"}, "claude", "h"))
        self.mem.cambiar_estado(a["id"], "rechazada", "prefiero legibilidad")
        self.assertIn("prefiero legibilidad", self.mem.lecciones_texto())
        with self.assertRaises(ValueError):
            self.mem.cambiar_estado(a["id"], "inventado")

    def test_agenda_y_backoff(self):
        agenda = self.mem.agenda(self.anat)
        self.assertNotIn(self.nid("costo"), agenda)             # 2 líneas < min_lineas
        self.assertEqual(agenda[0], self.nid("total"))           # la más conectada/compleja primero
        self.mem.marcar_revisada(self.nid("total"), self.anat.neuronas[self.nid("total")].hash, aporto=0)
        self.assertNotIn(self.nid("total"), self.mem.agenda(self.anat))
        self.assertEqual(self.mem.d["neuronas"][self.nid("total")]["intervalo"], 14)


class TestCorteza(Base):
    def respuesta(self, data):
        return SimpleNamespace(
            stop_reason="end_turn", model="claude-opus-5-5",
            content=[SimpleNamespace(type="text", text=json.dumps(data))],
            usage=SimpleNamespace(input_tokens=900, output_tokens=300, cache_read_input_tokens=0, cache_creation_input_tokens=0))

    def test_sin_api_key(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertIn("sin ANTHROPIC_API_KEY", corteza.pensar(self.mem, self.anat)["motivo"])

    def test_modo_directo(self):
        cli_ = mock.MagicMock()
        cli_.beta.messages.create.return_value = self.respuesta(
            {"mejoras": [{"titulo": "Usar np.where", "categoria": "rendimiento", "severidad": "alta", "impacto": 9,
                          "esfuerzo": 2, "porque": "x", "propuesta": "y", "confianza": 0.8}], "resueltas": [], "resumen": "ok"})
        with mock.patch.object(corteza, "_cliente", return_value=cli_):
            r = corteza.pensar(self.mem, self.anat, "directo")
        self.assertEqual(r["enviadas"], 2)
        kwargs = cli_.beta.messages.create.call_args.kwargs
        self.assertEqual(kwargs["fallbacks"], "default")
        m = next(m for m in self.mem.d["mejoras"] if m["origen"] == "claude")
        self.assertEqual(m["impacto"], 5)                          # acotado a 1..5
        self.assertGreater(self.mem.d["uso"]["total"]["costo_usd"], 0)

    def test_modo_lote_envia_y_recoge(self):
        cli_ = mock.MagicMock()
        cli_.messages.batches.create.return_value = SimpleNamespace(id="msgbatch_1")
        with mock.patch.object(corteza, "_cliente", return_value=cli_):
            r = corteza.pensar(self.mem, self.anat, "lote")
            self.assertEqual(r["enviadas"], 2)
            self.assertGreater(self.mem.uso_hoy(), 0)               # reservado
            cli_.messages.batches.retrieve.return_value = SimpleNamespace(processing_status="ended")
            data = {"mejoras": [], "resueltas": [], "resumen": "sana"}
            cli_.messages.batches.results.return_value = [
                SimpleNamespace(custom_id=k, result=SimpleNamespace(type="succeeded", message=self.respuesta(data)))
                for k in self.mem.d["lote"]["neuronas"]]
            cli_.messages.batches.create.return_value = SimpleNamespace(id="msgbatch_2")
            r2 = corteza.pensar(self.mem, self.anat, "lote")
        self.assertEqual(r2["recogidas"], 2)
        self.assertEqual(self.mem.d["neuronas"][self.nid("total")]["resumen"], "sana")


class TestDecisionesIssue(unittest.TestCase):
    def test_sin_bloque(self):
        self.assertIn("No encontré", cli.aplicar_decisiones("hola")[0])


if __name__ == "__main__":
    unittest.main()
