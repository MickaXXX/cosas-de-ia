"""Almacenamiento privado de archivos.

Interfaz mínima reemplazable por almacenamiento de objetos privado al desplegar. Las rutas guardadas en
la base de datos son claves internas relativas; nunca se aceptan rutas provenientes del usuario.
"""
import hashlib
import os
import shutil
import uuid
from pathlib import Path
from typing import BinaryIO, Protocol

from .config import get_settings


class Storage(Protocol):
    def path(self, key: str) -> Path: ...
    def put_stream(self, key: str, stream: BinaryIO, max_bytes: int) -> tuple[int, str]: ...
    def put_file(self, key: str, src: Path, move: bool = False) -> tuple[int, str]: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...


class TooLarge(Exception):
    pass


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()


class LocalStorage:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents and p != self.root:
            raise ValueError("clave de almacenamiento fuera del directorio de datos")
        return p

    def tmp_path(self) -> Path:
        d = self.root / "tmp"
        d.mkdir(exist_ok=True)
        return d / uuid.uuid4().hex

    def put_stream(self, key: str, stream: BinaryIO, max_bytes: int) -> tuple[int, str]:
        tmp = self.tmp_path()
        h = hashlib.sha256()
        size = 0
        try:
            with open(tmp, "wb") as f:
                while chunk := stream.read(1 << 20):
                    size += len(chunk)
                    if size > max_bytes:
                        raise TooLarge()
                    h.update(chunk)
                    f.write(chunk)
            self._finalize(tmp, key)
        finally:
            tmp.unlink(missing_ok=True)
        return size, h.hexdigest()

    def put_file(self, key: str, src: Path, move: bool = False) -> tuple[int, str]:
        digest = sha256_file(src)
        size = src.stat().st_size
        dst = self.path(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        if move:
            shutil.move(src, dst)
        else:
            shutil.copyfile(src, dst)
        return size, digest

    def _finalize(self, tmp: Path, key: str) -> None:
        dst = self.path(key)
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(tmp, dst)

    def make_immutable(self, key: str) -> None:
        os.chmod(self.path(key), 0o444)

    def exists(self, key: str) -> bool:
        return self.path(key).exists()

    def delete(self, key: str) -> None:
        p = self.path(key)
        if p.exists():
            os.chmod(p, 0o644)
            p.unlink()


_storage: LocalStorage | None = None


def get_storage() -> LocalStorage:
    global _storage
    if _storage is None:
        _storage = LocalStorage(get_settings().data_dir)
    return _storage
