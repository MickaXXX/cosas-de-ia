"""Lector/escritor PLY mínimo (binario little-endian y ASCII para leer; binario para escribir).

Cubre lo que producen OpenMVS/COLMAP: elementos con propiedades escalares y listas (p. ej. `vertex_indices`
y `texcoord` por cara). Implementación propia para no incorporar dependencias GPL en el proceso de la app.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1", "short": "i2", "int16": "i2",
    "ushort": "u2", "uint16": "u2", "int": "i4", "int32": "i4", "uint": "u4", "uint32": "u4",
    "float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
}


class PlyError(Exception):
    pass


@dataclass
class Element:
    name: str
    count: int
    props: list[tuple] = field(default_factory=list)  # (nombre, tipo) o (nombre, "list", tipo_cuenta, tipo_valor)


@dataclass
class Header:
    fmt: str
    elements: list[Element]
    comments: list[str]
    data_offset: int

    def element(self, name: str) -> Element | None:
        return next((e for e in self.elements if e.name == name), None)


def read_header(path: Path) -> Header:
    with open(path, "rb") as f:
        if f.readline().strip() != b"ply":
            raise PlyError("No es un archivo PLY")
        fmt, elements, comments = None, [], []
        while True:
            line = f.readline()
            if not line:
                raise PlyError("Cabecera PLY sin end_header")
            parts = line.decode("ascii", "replace").strip().split()
            if not parts:
                continue
            if parts[0] == "format":
                fmt = parts[1]
            elif parts[0] == "comment":
                comments.append(line.decode("utf-8", "replace").strip()[len("comment "):])
            elif parts[0] == "element":
                elements.append(Element(parts[1], int(parts[2])))
            elif parts[0] == "property":
                if parts[1] == "list":
                    elements[-1].props.append((parts[4], "list", TYPES[parts[2]], TYPES[parts[3]]))
                else:
                    elements[-1].props.append((parts[2], TYPES[parts[1]]))
            elif parts[0] == "end_header":
                return Header(fmt, elements, comments, f.tell())


def read_ply(path: Path) -> tuple[Header, dict[str, dict[str, np.ndarray]]]:
    """Devuelve {elemento: {propiedad: arreglo}}. Las listas de longitud fija se devuelven como 2D;
    si la longitud varía se lanza PlyError (no ocurre con mallas triangulares del motor)."""
    h = read_header(path)
    raw = Path(path).read_bytes()
    if h.fmt == "ascii":
        return h, _read_ascii(h, raw[h.data_offset:])
    if h.fmt != "binary_little_endian":
        raise PlyError(f"Formato PLY {h.fmt} no admitido")
    pos = h.data_offset
    out: dict[str, dict[str, np.ndarray]] = {}
    for el in h.elements:
        if all(len(p) == 2 for p in el.props):
            dt = np.dtype([(p[0], "<" + p[1]) for p in el.props])
            arr = np.frombuffer(raw, dtype=dt, count=el.count, offset=pos)
            pos += dt.itemsize * el.count
            out[el.name] = {p[0]: arr[p[0]] for p in el.props}
            continue
        # Elemento con listas: se asume longitud constante y se verifica en cada fila con un dtype fijo.
        sizes = []
        p0 = pos
        for p in el.props:
            if len(p) == 2:
                sizes.append(None)
            else:
                n = int(np.frombuffer(raw, dtype="<" + p[2], count=1, offset=p0)[0])
                sizes.append(n)
            p0 += np.dtype(p[1] if len(p) == 2 else p[2]).itemsize + (0 if len(p) == 2 else sizes[-1] * np.dtype(p[3]).itemsize)
        fields = []
        for p, n in zip(el.props, sizes):
            if len(p) == 2:
                fields.append((p[0], "<" + p[1]))
            else:
                fields.append((p[0] + "__n", "<" + p[2]))
                fields.append((p[0], "<" + p[3], (n,)))
        dt = np.dtype(fields)
        if pos + dt.itemsize * el.count > len(raw):
            raise PlyError(f"Elemento {el.name}: datos insuficientes o listas de longitud variable")
        arr = np.frombuffer(raw, dtype=dt, count=el.count, offset=pos)
        if any(len(p) == 4 and el.count and not np.all(arr[p[0] + "__n"] == n) for p, n in zip(el.props, sizes)):
            out[el.name], pos = _read_variable(raw, pos, el)  # listas de longitud variable: camino general
            continue
        pos += dt.itemsize * el.count
        out[el.name] = {p[0]: arr[p[0]] for p in el.props}
    return h, out


def _read_variable(raw: bytes, pos: int, el: Element) -> tuple[dict[str, np.ndarray], int]:
    cols: dict[str, list] = {p[0]: [] for p in el.props}
    for _ in range(el.count):
        for p in el.props:
            if len(p) == 2:
                dt = np.dtype("<" + p[1])
                cols[p[0]].append(np.frombuffer(raw, dtype=dt, count=1, offset=pos)[0])
                pos += dt.itemsize
            else:
                ct, vt = np.dtype("<" + p[2]), np.dtype("<" + p[3])
                n = int(np.frombuffer(raw, dtype=ct, count=1, offset=pos)[0])
                pos += ct.itemsize
                cols[p[0]].append(np.frombuffer(raw, dtype=vt, count=n, offset=pos).copy())
                pos += vt.itemsize * n
    res = {}
    for p in el.props:
        if len(p) == 2:
            res[p[0]] = np.array(cols[p[0]])
        else:
            obj = np.empty(el.count, dtype=object)
            obj[:] = cols[p[0]]
            res[p[0]] = obj
    return res, pos


def _read_ascii(h: Header, body: bytes) -> dict[str, dict[str, np.ndarray]]:
    tokens = body.split()
    i = 0
    out = {}
    for el in h.elements:
        cols: dict[str, list] = {p[0]: [] for p in el.props}
        for _ in range(el.count):
            for p in el.props:
                if len(p) == 2:
                    cols[p[0]].append(float(tokens[i]))
                    i += 1
                else:
                    n = int(tokens[i])
                    cols[p[0]].append([float(t) for t in tokens[i + 1:i + 1 + n]])
                    i += 1 + n
        out[el.name] = {k: np.array(v) for k, v in cols.items()}
    return out


def write_ply(path: Path, vertices: np.ndarray, faces: np.ndarray, face_uvs: np.ndarray | None = None,
              comments: list[str] | None = None) -> None:
    """Escribe una malla triangular binaria (con UV por esquina opcional, como OpenMVS)."""
    head = ["ply", "format binary_little_endian 1.0", *[f"comment {c}" for c in comments or []],
            f"element vertex {len(vertices)}", "property float x", "property float y", "property float z",
            f"element face {len(faces)}", "property list uchar uint vertex_indices"]
    fields = [("n", "u1"), ("idx", "<u4", (3,))]
    if face_uvs is not None:
        head.append("property list uchar float texcoord")
        fields += [("m", "u1"), ("uv", "<f4", (6,))]
    head.append("end_header")
    rec = np.zeros(len(faces), dtype=np.dtype(fields))
    rec["n"] = 3
    rec["idx"] = faces
    if face_uvs is not None:
        rec["m"] = 6
        rec["uv"] = np.asarray(face_uvs, np.float32).reshape(-1, 6)
    with open(path, "wb") as f:
        f.write(("\n".join(head) + "\n").encode())
        f.write(np.ascontiguousarray(vertices, dtype="<f4").tobytes())
        f.write(rec.tobytes())
