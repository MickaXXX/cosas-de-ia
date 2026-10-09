"""Importa pycolmap sin perder el apagado ordenado del proceso.

Al importarse, pycolmap instala el manejador de fallos de glog, que también captura SIGTERM/SIGINT y aborta
el proceso. En el trabajador eso impediría el apagado ordenado de Celery (p. ej. `docker compose stop`).
Se restauran los manejadores previos de SIGTERM y SIGINT; los de fallos reales (SIGSEGV, etc.) se mantienen.
"""
import signal
import threading


def pycolmap():
    restore = threading.current_thread() is threading.main_thread()
    saved = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)} if restore else {}
    import pycolmap as _pycolmap

    for s, h in saved.items():
        signal.signal(s, h if h is not None else signal.SIG_DFL)
    return _pycolmap
