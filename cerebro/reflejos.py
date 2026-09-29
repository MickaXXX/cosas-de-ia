"""Reflejos: detecciones estáticas que no gastan ni un token.

Son los patrones que cualquier revisor marcaría sin pensar. Corren en cada ciclo
sobre todas las neuronas; lo que detectan se guarda como mejora (origen "reflejo")
y se le pasa a Claude como "ya detectado" para que no lo repita y gaste su
presupuesto en lo que un linter no ve.

Si un reflejo deja de dispararse sobre una mejora pendiente o aceptada, es que el
código ya se corrigió: la mejora pasa sola a "aplicada".
"""
from __future__ import annotations

import ast
from collections import Counter

from .anatomia import Neurona

BUCLES = (ast.For, ast.AsyncFor, ast.While, ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)
TRIVIALES = {"print", "len", "range", "int", "float", "str", "list", "set", "dict", "tuple", "sum",
             "min", "max", "sorted", "enumerate", "zip", "isinstance", "append", "update", "get",
             "items", "keys", "values", "copy", "strip", "split", "join", "format", "close", "figure"}


def _propios(nodo: ast.AST):
    """Recorre el cuerpo de la neurona sin entrar en funciones anidadas (son neuronas aparte)."""
    pila = list(getattr(nodo, "body", []))
    while pila:
        x = pila.pop()
        yield x
        if isinstance(x, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            continue
        pila.extend(ast.iter_child_nodes(x))


def _dentro_de_bucle(nodo: ast.AST) -> list[ast.AST]:
    """Nodos que están dentro de algún bucle de la neurona."""
    dentro = []
    for b in _propios(nodo):
        if isinstance(b, BUCLES):
            cuerpo = b.body if hasattr(b, "body") and isinstance(b.body, list) else [b]
            for c in cuerpo:
                dentro += [c, *ast.walk(c)]
    return dentro


def _metodo(x: ast.AST, nombre: str) -> bool:
    return isinstance(x, ast.Call) and isinstance(x.func, ast.Attribute) and x.func.attr == nombre


def _mejora(regla, titulo, categoria, severidad, impacto, esfuerzo, porque, propuesta=""):
    return {"regla": regla, "titulo": titulo, "categoria": categoria, "severidad": severidad,
            "impacto": impacto, "esfuerzo": esfuerzo, "porque": porque, "propuesta": propuesta,
            "confianza": 0.9}


def revisar(n: Neurona) -> list[dict]:
    nodo = n.nodo
    if nodo is None:
        return []
    propios = list(_propios(nodo))
    en_bucle = _dentro_de_bucle(nodo)
    out: list[dict] = []

    # 1. parámetros que nunca se usan
    if isinstance(nodo, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args = [a.arg for a in nodo.args.posonlyargs + nodo.args.args + nodo.args.kwonlyargs]
        leidos = {x.id for x in ast.walk(nodo) if isinstance(x, ast.Name) and isinstance(x.ctx, ast.Load)}
        muertos = [a for a in args if a not in leidos and a not in ("self", "cls") and not a.startswith("_")]
        if muertos:
            out.append(_mejora(
                "param_sin_uso", f"Parámetros sin uso: {', '.join(muertos)}", "diseno", "media", 3, 1,
                f"{n.nombre} recibe {', '.join(muertos)} pero nunca los lee. Confunde al lector y obliga a "
                "cada llamador a calcular y pasar datos que no sirven.",
                f"Quitar {', '.join(muertos)} de la firma y de todas las llamadas a {n.nombre}."))

    # 2. iterrows
    if any(_metodo(x, "iterrows") for x in propios):
        out.append(_mejora(
            "iterrows", "Recorrer con iterrows() en vez de operar vectorizado", "rendimiento", "alta", 4, 2,
            "iterrows crea una Series por fila: es 100–1000× más lento que operar sobre columnas.",
            "Usar operaciones de columna (np.where, cummax, máscaras) o, si hay que iterar, itertuples()."))

    # 3. apply(axis=1)
    for x in propios:
        if _metodo(x, "apply") and any(k.arg == "axis" and isinstance(k.value, ast.Constant) and k.value.value == 1
                                      for k in x.keywords):
            out.append(_mejora(
                "apply_axis1", "apply(axis=1) fila por fila", "rendimiento", "alta", 4, 3,
                "apply con axis=1 llama a Python una vez por fila y arma una Series en cada una. "
                "Con fórmulas aritméticas se puede calcular la columna completa de una vez con numpy.",
                "Mapear parámetros por clase con .map() y calcular columnas con operaciones vectorizadas "
                "(p. ej. np.sqrt(df['R'] + df['L']) * df['sigma'])."))
            break

    # 4. gc.collect dentro de bucles o repetido
    gcs = [x for x in propios if isinstance(x, ast.Call) and ast.unparse(x.func) == "gc.collect"]
    if any(g in en_bucle for g in gcs) or len(gcs) >= 2:
        titulo = "gc.collect() dentro del bucle" if any(g in en_bucle for g in gcs) else f"gc.collect() repetido ({len(gcs)} veces)"
        out.append(_mejora(
            "gc_en_bucle", titulo, "rendimiento", "media", 3, 1,
            "Forzar el recolector en cada vuelta cuesta tiempo (recorre todos los objetos vivos) y casi nunca "
            "libera algo que CPython no hubiera liberado ya por conteo de referencias.",
            "Quitar gc.collect() del bucle; si hace falta, llamarlo una sola vez al final del proceso."))

    # 5. del de variables locales justo antes de salir
    dels = [x for x in getattr(nodo, "body", []) if isinstance(x, ast.Delete)]
    if dels and n.tipo != "script":
        out.append(_mejora(
            "del_local", "del de variables locales al final de la función", "legibilidad", "baja", 1, 1,
            "Las variables locales se liberan solas al retornar; el del explícito solo agrega ruido.",
            "Eliminar las sentencias del al final de la función."))

    # 6. == True / == False
    for x in propios:
        if isinstance(x, ast.Compare) and any(isinstance(c, ast.Constant) and c.value in (True, False)
                                              and type(c.value) is bool for c in x.comparators):
            out.append(_mejora(
                "igual_true", "Comparación explícita con == True/False", "legibilidad", "baja", 1, 1,
                "En pandas basta con usar la columna booleana como máscara: df[df['col']] o df[~df['col']].",
                ast.unparse(x) + "  →  " + ast.unparse(x.left)))
            break

    # 7. semilla global
    for x in propios:
        if isinstance(x, ast.Call) and ast.unparse(x.func) in ("np.random.seed", "numpy.random.seed", "random.seed"):
            out.append(_mejora(
                "semilla_global", "Semilla aleatoria global", "reproducibilidad", "media", 3, 2,
                "np.random.seed cambia el estado global: cualquier otra función que use np.random altera la "
                "secuencia y los resultados dejan de ser comparables entre corridas.",
                "rng = np.random.default_rng(seed) y pasar rng a las funciones que generan aleatorios."))
            break

    # 8. .copy() dentro de un bucle
    if any(_metodo(x, "copy") for x in en_bucle):
        out.append(_mejora(
            "copia_en_bucle", "Copia de DataFrame en cada vuelta", "rendimiento", "media", 3, 2,
            "Copiar un DataFrame completo en cada iteración multiplica memoria y tiempo.",
            "Copiar solo las columnas necesarias, o trabajar sobre vistas/arrays y copiar una vez fuera del bucle."))

    # 9. for i in range(len(x))
    for x in propios:
        if isinstance(x, ast.For) and isinstance(x.iter, ast.Call) and ast.unparse(x.iter).startswith("range(len("):
            out.append(_mejora(
                "range_len", "for i in range(len(...))", "legibilidad", "baja", 1, 1,
                "Iterar por índice es más frágil y menos claro que iterar sobre los elementos.",
                "for i, elem in enumerate(secuencia):"))
            break

    # 10. except desnudo
    if any(isinstance(x, ast.ExceptHandler) and x.type is None for x in propios):
        out.append(_mejora(
            "except_desnudo", "except: sin tipo de excepción", "robustez", "alta", 3, 1,
            "Atrapa también KeyboardInterrupt y errores de programación, y los esconde.",
            "except Exception as e: (o la excepción concreta que se espera)."))

    # 11. misma llamada repetida (cálculo duplicado)
    llamadas = Counter(ast.unparse(x) for x in propios if isinstance(x, ast.Call)
                       and not (isinstance(x.func, (ast.Name, ast.Attribute))
                                and (getattr(x.func, "id", None) or getattr(x.func, "attr", "")) in TRIVIALES)
                       and x.args)
    repetidas = [c for c, k in llamadas.items() if k >= 2 and len(c) > 12]
    if repetidas:
        out.append(_mejora(
            "calculo_repetido", f"Cálculo repetido: {repetidas[0][:60]}", "rendimiento", "baja", 2, 1,
            "La misma expresión se evalúa más de una vez con los mismos argumentos.",
            f"Calcularla una vez y guardarla en una variable: {repetidas[0][:80]}"))

    # 12. neurona demasiado grande
    if n.tipo != "script" and (n.lineas > 70 or n.complejidad > 15):
        out.append(_mejora(
            "neurona_grande", f"Función grande ({n.lineas} líneas, complejidad {n.complejidad})", "diseno",
            "media", 3, 3,
            "Una función que hace muchas cosas es difícil de probar y de cambiar sin romper algo.",
            "Separar en funciones con una sola responsabilidad (cálculo, agregación, presentación)."))

    # 13. sin docstring
    if n.tipo in ("funcion", "metodo") and not n.doc and n.lineas >= 10:
        out.append(_mejora(
            "sin_doc", "Falta docstring", "legibilidad", "baja", 1, 1,
            "Sin una línea que diga qué entra y qué sale, hay que leer toda la función para usarla.",
            f'"""Qué hace {n.nombre}, qué recibe y qué devuelve."""'))

    return out
