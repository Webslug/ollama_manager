"""Talks to Ollama through its HTTP API and the ollama CLI."""
import json
import os
import re
import subprocess
import threading
import urllib.error
import urllib.request
import uuid

from .functions_config import settings
from .functions_log import debug_log, log_event
from .functions_system import run


def api(path, payload=None, timeout=5):
    url = settings.OLLAMA_URL + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode()
            return json.loads(body) if body else {}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        debug_log(f"api {path} failed: {exc}")
        return None


def version():
    data = api("/api/version")
    return data.get("version") if data else None


def loaded_models():
    data = api("/api/ps")
    if not data:
        return []
    return [{
        "name": m.get("name"),
        "size_mb": round(m.get("size", 0) / 1048576),
        "vram_mb": round(m.get("size_vram", 0) / 1048576),
        "expires_at": m.get("expires_at"),
    } for m in data.get("models", [])]


def unload(model):
    return api("/api/generate", {"model": model, "keep_alive": 0}, timeout=30) is not None


def list_models():
    rc, out, err = run([settings.OLLAMA_BIN, "list"])
    if rc != 0:
        return None, err.strip() or "ollama list failed"
    models = []
    for line in out.strip().splitlines()[1:]:
        cols = re.split(r"\s{2,}", line.strip())
        if len(cols) >= 3:
            models.append({
                "name": cols[0], "id": cols[1], "size": cols[2],
                "modified": cols[3] if len(cols) > 3 else "",
            })
    return models, None


def model_exists(name):
    models, _ = list_models()
    wanted = {name, name + ":latest"}
    return bool(models) and any(m["name"] in wanted for m in models)


def remove(model):
    rc, out, err = run([settings.OLLAMA_BIN, "rm", model], timeout=60)
    if rc == 0:
        log_event(f"REMOVED model '{model}'")
        return True, out.strip()
    return False, (err or out).strip()


def show_modelfile(model):
    rc, out, err = run([settings.OLLAMA_BIN, "show", "--modelfile", model], timeout=30)
    return (out, None) if rc == 0 else (None, err.strip())


# ----- background create jobs -----
_jobs = {}
_jobs_lock = threading.Lock()


def _run_create(job_id, name, modelfile_path, gguf_path):
    job = _jobs[job_id]
    cmd = [settings.OLLAMA_BIN, "create", name, "-f", modelfile_path]
    debug_log("create: " + " ".join(cmd))
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        buffer = b""
        while True:
            chunk = os.read(proc.stdout.fileno(), 1024)
            if not chunk:
                break
            buffer += chunk
            parts = re.split(rb"[\r\n]+", buffer)
            buffer = parts.pop()
            for part in parts:
                text = part.decode("utf-8", errors="replace").strip()
                if text:
                    job["lines"] = (job["lines"] + [text])[-40:]
        proc.wait(timeout=settings.CREATE_TIMEOUT)
        job["returncode"] = proc.returncode
    except Exception as exc:
        job["lines"].append(str(exc))
        job["returncode"] = 1
    if job["returncode"] == 0:
        job["status"] = "done"
        log_event(f"ADDED model '{name}' from {gguf_path}")
    else:
        job["status"] = "failed"
        log_event(f"FAILED to add model '{name}' (exit {job['returncode']})")


def start_create(name, modelfile_path, gguf_path):
    job_id = uuid.uuid4().hex[:12]
    with _jobs_lock:
        _jobs[job_id] = {"status": "running", "lines": [], "returncode": None, "name": name}
    threading.Thread(target=_run_create, args=(job_id, name, modelfile_path, gguf_path),
                     daemon=True).start()
    return job_id


def job_status(job_id):
    return _jobs.get(job_id)
