"""Event log. Model add/remove is always recorded; extra audit lines need DEBUG_MODE."""
import os
import threading
from datetime import datetime

from .functions_config import settings

_lock = threading.Lock()
_NOTICE = "[log truncated: oldest entries removed]\n"


def _truncate_if_needed():
    path = settings.LOG_FILE
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    if size <= settings.LOG_MAX_BYTES:
        return
    keep = settings.LOG_MAX_BYTES // 2
    with open(path, "rb") as fh:
        fh.seek(-keep, os.SEEK_END)
        tail = fh.read()
    cut = tail.find(b"\n")
    if cut != -1:
        tail = tail[cut + 1:]
    with open(path, "wb") as fh:
        fh.write(_NOTICE.encode("utf-8") + tail)


def _write(level, message):
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{stamp} [{level}] {message}\n"
    with _lock:
        os.makedirs(os.path.dirname(settings.LOG_FILE), exist_ok=True)
        with open(settings.LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(line)
        _truncate_if_needed()
    if settings.DEBUG_MODE:
        print(line, end="")


def log_event(message):
    _write("EVENT", message)


def debug_log(message):
    if settings.DEBUG_MODE:
        _write("DEBUG", message)


def read_log(max_bytes=20000):
    try:
        with open(settings.LOG_FILE, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            return fh.read().decode("utf-8", errors="replace")
    except OSError:
        return ""
