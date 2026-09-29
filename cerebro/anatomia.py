"""Anatomía de un cerebro de código: convierte archivos Python en neuronas y sinapsis.

Cada función (y cada función anidada) es una neurona. El código suelto a nivel de
módulo (el "bloque principal") es una neurona más, de tipo `script`. Las sinapsis
son las llamadas entre neuronas; además se registran las librerías que usa cada una.

Todo es análisis estático con `ast`: no gasta tokens y corre en milisegundos, así
que se rehace completo en cada ciclo.
"""
from __future__ import annotations

import ast
import hashlib
import sys
from dataclasses import dataclass, field
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
STDLIB = set(getattr(sys, "stdlib_module_names", ()))


@dataclass
class Neurona:
    id: str                 # "ruta/archivo.py::padre.funcion" — estable mientras no se renombre
    nombre: str
    qual: str
    archivo: str
    linea: int
    fin: int
    tipo: str               # funcion | anidada | metodo | script
    padre: str | None       # id de la neurona que la define (None si cuelga del archivo)
    firma: str
    doc: str
    codigo: str
    hash: str               # huella del código normalizado (ignora comentarios y espacios)
    complejidad: int
    llama: list[str] = field(default_factory=list)      # ids de neuronas
    libs: list[str] = field(default_factory=list)       # librerías que usa
    nodo: ast.AST | None = field(default=None, repr=False)
    n_lineas: int | None = None                          # solo para el bloque principal (disperso)

    @property
    def lineas(self) -> int:
        return self.n_lineas or (self.fin - self.linea + 1)

    def publica(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if k != "nodo"} | {"lineas": self.lineas}


@dataclass
class Anatomia:
    neuronas: dict[str, Neurona]
    archivos: dict[str, dict]         # ruta -> {"libs": [...], "lineas": n}

    def llamadores(self) -> dict[str, list[str]]:
        inv: dict[str, list[str]] = {nid: [] for nid in self.neuronas}
        for n in self.neuronas.values():
            for dest in n.llama:
                inv.setdefault(dest, []).append(n.id)
        return inv


def _huella(nodo: ast.AST | list) -> str:
    cuerpo = nodo if isinstance(nodo, list) else [nodo]
    texto = "\n".join(ast.unparse(x) for x in cuerpo)
    return hashlib.sha1(texto.encode()).hexdigest()[:12]


def _complejidad(nodo: ast.AST) -> int:
    """Complejidad ciclomática aproximada (sin entrar en funciones anidadas)."""
    total = 1
    pila = list(ast.iter_child_nodes(nodo))
    while pila:
        x = pila.pop()
        if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        if isinstance(x, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.IfExp, ast.ExceptHandler,
                          ast.comprehension, ast.Assert, ast.match_case)):
            total += 1
        elif isinstance(x, ast.BoolOp):
            total += len(x.values) - 1
        pila.extend(ast.iter_child_nodes(x))
    return total


def _firma(nodo: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    return f"{nodo.name}({ast.unparse(nodo.args)})"


def _alias_importados(arbol: ast.Module) -> dict[str, str]:
    """alias local -> paquete raíz. `import numpy as np` => {"np": "numpy"}."""
    alias = {}
    for x in ast.walk(arbol):
        if isinstance(x, ast.Import):
            for a in x.names:
                alias[a.asname or a.name.split(".")[0]] = a.name.split(".")[0]
        elif isinstance(x, ast.ImportFrom) and x.module and x.level == 0:
            for a in x.names:
                alias[a.asname or a.name] = x.module.split(".")[0]
    return alias


def _nombres_usados(nodos: list[ast.AST]) -> tuple[set[str], set[str]]:
    """(nombres llamados directamente, nombres leídos) sin entrar en defs anidadas."""
    llamados, leidos = set(), set()
    pila = list(nodos)
    while pila:
        x = pila.pop()
        if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # decoradores y valores por defecto sí pertenecen al ámbito que define
            pila.extend(x.decorator_list)
            continue
        if isinstance(x, ast.Call):
            f = x.func
            if isinstance(f, ast.Name):
                llamados.add(f.id)
            elif isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id in ("self", "cls"):
                llamados.add("self." + f.attr)
        if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load):
            leidos.add(x.id)
        pila.extend(ast.iter_child_nodes(x))
    return llamados, leidos


def _cuerpo_propio(nodo: ast.AST) -> list[ast.AST]:
    return [*getattr(nodo, "body", [])]


def analizar_archivo(ruta: Path, rel: str) -> tuple[list[Neurona], dict]:
    fuente = ruta.read_text(encoding="utf-8")
    arbol = ast.parse(fuente, filename=rel)
    lineas_src = fuente.splitlines()
    alias = _alias_importados(arbol)
    neuronas: list[Neurona] = []

    def fragmento(a: int, b: int) -> str:
        return "\n".join(lineas_src[a - 1:b])

    def visitar(cuerpo, padre: Neurona | None, prefijo: str, en_clase: str | None):
        for x in cuerpo:
            if padre and isinstance(x, (ast.For, ast.AsyncFor, ast.While, ast.If, ast.With, ast.AsyncWith, ast.Try)):
                # funciones definidas dentro de un bucle o condicional siguen siendo hijas de la neurona
                for campo in ("body", "orelse", "finalbody"):
                    visitar(getattr(x, campo, []), padre, prefijo, en_clase)
                for h in getattr(x, "handlers", []):
                    visitar(h.body, padre, prefijo, en_clase)
            elif isinstance(x, ast.ClassDef):
                visitar(x.body, padre, f"{prefijo}{x.name}.", x.name)
            elif isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qual = prefijo + x.name
                inicio = min([d.lineno for d in x.decorator_list] + [x.lineno])
                tipo = "metodo" if en_clase else ("anidada" if padre else "funcion")
                n = Neurona(
                    id=f"{rel}::{qual}", nombre=x.name, qual=qual, archivo=rel,
                    linea=inicio, fin=x.end_lineno, tipo=tipo, padre=padre.id if padre else None,
                    firma=_firma(x), doc=(ast.get_docstring(x) or "").strip().split("\n")[0][:200],
                    codigo=fragmento(inicio, x.end_lineno), hash=_huella(x),
                    complejidad=_complejidad(x), nodo=x,
                )
                neuronas.append(n)
                visitar(x.body, n, qual + ".", None)

    visitar(arbol.body, None, "", None)

    # El bloque principal: todo lo que no es def/class/import a nivel de módulo.
    sueltos = [x for x in arbol.body if not isinstance(
        x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom))
        and not (isinstance(x, ast.Expr) and isinstance(getattr(x, "value", None), ast.Constant))]
    if sueltos:
        a, b = sueltos[0].lineno, sueltos[-1].end_lineno
        modulo = ast.Module(body=sueltos, type_ignores=[])
        neuronas.append(Neurona(
            id=f"{rel}::<principal>", nombre="bloque principal", qual="<principal>", archivo=rel,
            linea=a, fin=b, tipo="script", padre=None, firma=f"{Path(rel).name} (nivel de módulo)",
            doc="Código que se ejecuta al correr el archivo.",
            codigo="\n\n".join(fragmento(s.lineno, s.end_lineno) for s in sueltos),
            hash=_huella(sueltos), complejidad=_complejidad(modulo), nodo=modulo,
            n_lineas=sum(s.end_lineno - s.lineno + 1 for s in sueltos),
        ))

    libs_archivo = sorted({alias[a] for a in alias})
    return neuronas, {"libs": libs_archivo, "lineas": len(lineas_src), "alias": alias}


def _resolver(neuronas: list[Neurona], alias_por_archivo: dict[str, dict]) -> None:
    """Conecta sinapsis: nombre llamado -> neurona definida en el proyecto."""
    por_nombre: dict[str, list[Neurona]] = {}
    por_qual: dict[tuple[str, str], Neurona] = {}
    for n in neuronas:
        por_nombre.setdefault(n.nombre, []).append(n)
        por_qual[(n.archivo, n.qual)] = n

    for n in neuronas:
        llamados, leidos = _nombres_usados(_cuerpo_propio(n.nodo))
        alias = alias_por_archivo[n.archivo]
        destinos = []
        for nombre in sorted(llamados | leidos):
            if nombre.startswith("self."):
                clase = n.qual.rsplit(".", 1)[0] if "." in n.qual else ""
                d = por_qual.get((n.archivo, f"{clase}.{nombre[5:]}"))
                if d:
                    destinos.append(d.id)
                continue
            # 1) una función anidada dentro de esta neurona, 2) una del mismo archivo, 3) única en el proyecto
            hija = por_qual.get((n.archivo, f"{n.qual}.{nombre}")) if n.tipo != "script" else None
            mismo = [c for c in por_nombre.get(nombre, []) if c.archivo == n.archivo and c.padre is None]
            candidatos = [hija] if hija else (mismo or por_nombre.get(nombre, []))
            if len(candidatos) == 1 and candidatos[0].id != n.id:
                destinos.append(candidatos[0].id)
        n.llama = sorted(set(destinos))
        n.libs = sorted({alias[x] for x in leidos | {c for c in llamados if "." not in c} if x in alias})


def escanear(rutas: list[str], excluir: list[str] | None = None, raiz: Path = RAIZ) -> Anatomia:
    excluir = excluir or []
    archivos: list[Path] = []
    for r in rutas:
        p = (raiz / r)
        archivos += [p] if p.is_file() else sorted(p.rglob("*.py"))
    neuronas: list[Neurona] = []
    info: dict[str, dict] = {}
    for f in archivos:
        rel = f.relative_to(raiz).as_posix()
        if any(e in rel for e in excluir) or "__pycache__" in rel:
            continue
        try:
            ns, meta = analizar_archivo(f, rel)
        except SyntaxError as e:
            print(f"  ! {rel}: no se pudo leer ({e})", file=sys.stderr)
            continue
        neuronas += ns
        info[rel] = meta
    _resolver(neuronas, {k: v["alias"] for k, v in info.items()})
    for meta in info.values():
        meta.pop("alias", None)
    return Anatomia({n.id: n for n in neuronas}, info)


def es_stdlib(lib: str) -> bool:
    return lib in STDLIB
