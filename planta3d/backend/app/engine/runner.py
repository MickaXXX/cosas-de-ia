"""Ejecución de binarios del motor con argumentos estructurados (sin shell).

- Cada proceso corre en su propia sesión/grupo: la cancelación termina el árbol completo.
- PR_SET_PDEATHSIG: si el trabajador muere, el hijo recibe SIGKILL (sin procesos huérfanos).
- Límite de memoria virtual opcional (RLIMIT_AS) y tiempo máximo por etapa.
- Se registran comando efectivo, código de salida, stdout/stderr, duración y memoria pico (ru_maxrss).
"""
from __future__ import annotations

import ctypes
import os
import resource
import signal
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

PR_SET_PDEATHSIG = 1


class Cancelled(Exception):
    pass


class StageTimeout(Exception):
    pass


@dataclass
class RunResult:
    args: list[str]
    returncode: int
    seconds: float
    max_rss_mb: float
    stdout_path: str
    stderr_path: str


def _preexec(mem_limit_bytes: int | None):
    def fn():
        try:
            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
        except OSError:
            pass
        if mem_limit_bytes:
            resource.setrlimit(resource.RLIMIT_AS, (mem_limit_bytes, mem_limit_bytes))
        os.nice(5)
    return fn


def kill_group(pgid: int, grace: float = 10.0) -> None:
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.time() + grace
    while time.time() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def run(args: list[str], cwd: Path, log_prefix: Path, timeout_s: float,
        should_cancel: Callable[[], bool], on_start: Callable[[int], None] | None = None,
        heartbeat: Callable[[], None] | None = None, env: dict | None = None,
        mem_limit_bytes: int | None = None) -> RunResult:
    log_prefix.parent.mkdir(parents=True, exist_ok=True)
    out_p, err_p = log_prefix.with_suffix(".stdout.log"), log_prefix.with_suffix(".stderr.log")
    t0 = time.time()
    with open(out_p, "wb") as out, open(err_p, "wb") as err:
        proc = subprocess.Popen(args, cwd=cwd, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                start_new_session=True, preexec_fn=_preexec(mem_limit_bytes),
                                env={**os.environ, **(env or {})})
        pgid = proc.pid
        if on_start:
            on_start(pgid)
        last_check = 0.0
        rusage = None
        status = None
        try:
            while True:
                pid, status, rusage = os.wait4(proc.pid, os.WNOHANG)
                if pid != 0:
                    proc.returncode = os.waitstatus_to_exitcode(status)
                    break
                now = time.time()
                if now - t0 > timeout_s:
                    kill_group(pgid)
                    raise StageTimeout(f"La etapa superó el tiempo máximo de {int(timeout_s)} s")
                if now - last_check > 2.0:
                    last_check = now
                    if heartbeat:
                        heartbeat()
                    if should_cancel():
                        kill_group(pgid)
                        raise Cancelled()
                time.sleep(0.25)
        except BaseException:
            kill_group(pgid, grace=2.0)
            try:
                os.waitpid(proc.pid, 0)
            except ChildProcessError:
                pass
            raise
        # Asegura que no quedan nietos vivos en el grupo.
        if group_alive(pgid):
            kill_group(pgid, grace=2.0)
    return RunResult(args=[str(a) for a in args], returncode=proc.returncode, seconds=time.time() - t0,
                     max_rss_mb=(rusage.ru_maxrss / 1024.0) if rusage else 0.0,
                     stdout_path=str(out_p), stderr_path=str(err_p))


def tail(path: str | Path, n: int = 25) -> str:
    try:
        lines = Path(path).read_text(errors="replace").splitlines()
    except FileNotFoundError:
        return ""
    return "\n".join(lines[-n:])
