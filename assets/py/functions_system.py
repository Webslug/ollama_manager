"""Systemd, GPU and disk helpers."""
import os
import re
import shutil
import subprocess
import sys

from .functions_config import settings
from .functions_log import debug_log

SETTING_RULES = {
    "OLLAMA_KEEP_ALIVE": re.compile(r"^(-1|\d{1,6}[smh]?)$"),
    "OLLAMA_FLASH_ATTENTION": re.compile(r"^[01]$"),
    "OLLAMA_KV_CACHE_TYPE": re.compile(r"^(f16|q8_0|q4_0)$"),
    "OLLAMA_NUM_PARALLEL": re.compile(r"^[1-9][0-9]?$"),
    "OLLAMA_MAX_LOADED_MODELS": re.compile(r"^[0-9]{1,2}$"),
    "OLLAMA_NUM_CTX": re.compile(r"^([1-9]\d{2,6})$"),  # 128-9,999,999 tokens
}


def run(cmd, timeout=15):
    """Run a command, return (returncode, stdout, stderr). Never raises."""
    debug_log("run: " + " ".join(cmd))
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", f"{cmd[0]} not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"


def service_state():
    _, out, _ = run(["systemctl", "is-active", settings.OLLAMA_SERVICE])
    return out.strip() or "unknown"


def service_env():
    _, out, _ = run(["systemctl", "show", settings.OLLAMA_SERVICE, "-p", "Environment", "--value"])
    env = {}
    for token in re.findall(r'(?:[^\s"]|"[^"]*")+', out):
        token = token.strip('"')
        if "=" in token:
            key, value = token.split("=", 1)
            env[key] = value
    # Also read drop-in file for OLLAMA_NUM_CTX (may not be in systemctl yet after write)
    dropin = "/etc/systemd/system/ollama.service.d/zz-manager.conf"
    try:
        with open(dropin, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'^Environment="(OLLAMA_NUM_CTX)=([^"]*)"$', line.strip())
                if m:
                    env[m.group(1)] = m.group(2)
    except (OSError, IOError):
        pass
    return env


def store_dir():
    return service_env().get("OLLAMA_MODELS") or settings.OLLAMA_STORE_FALLBACK


def vram():
    rc, out, _ = run([
        "nvidia-smi", "--query-gpu=name,memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ])
    if rc != 0 or not out.strip():
        return {"available": False}
    name, used, total = [p.strip() for p in out.strip().splitlines()[0].split(",")]
    used, total = int(used), int(total)
    return {
        "available": True,
        "name": name,
        "used_mb": used,
        "total_mb": total,
        "percent": round(100 * used / total, 1) if total else 0,
    }


def disk_free(path):
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


def helper_call(*args):
    """Run the whitelisted root helper. Needs the app to be launched via run.sh. Returns (ok, message)."""
    if os.geteuid() != 0:
        return False, "app is not running as root"
    rc, out, err = run([sys.executable, settings.HELPER_PATH, *args], timeout=60)
    if rc == 0:
        return True, out.strip()
    return False, (err or out).strip() or f"helper exited with {rc}"
