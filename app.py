#!/usr/bin/env python3
"""Ollama Manager: a small Flask front end for adding, removing and tuning Ollama models."""
import importlib.util
import json
import logging
import os
import socket
import sys

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask import cli as flask_cli

# ----------------------------------------------------------------------
# Constants: tweak these
# ----------------------------------------------------------------------
DEBUG_MODE = False                     # True = audit log lines + console output
HOST = "127.0.0.1"                     # keep on loopback: this app controls a daemon
PORT = 5782
PORT_TRIES = 50                        # if PORT is busy, try PORT+1 ... PORT+PORT_TRIES

OLLAMA_URL = "http://127.0.0.1:11434"
OLLAMA_BIN = "ollama"
OLLAMA_SERVICE = "ollama"
OLLAMA_DROPIN = "/etc/systemd/system/ollama.service.d/zz-manager.conf"  # Settings file; change if needed

DEFAULT_MODELS_DIR = "/media/storage/backup/AI/Models/"
OLLAMA_STORE_FALLBACK = "/media/storage/backup/AI/Models/Ollama"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_CONTEXT = 8192
DEFAULT_SYSTEM_PROMPT = "You are a friendly, helpful and honest disembodied AI assistant."
DEFAULT_KEEP_ALIVE = "15m"

LOG_FILENAME = "ollama_manager.log"
CHAT_DB_FILENAME = "chat.sqlite"        # created on demand in data/chat/
USER_NAME = "User"                     # {{user}} in the system prompt
CHAR_NAME = "Assistant"                # {{char}} in the system prompt
PROMPT_FILE = "prompt.txt"             # data/prompts/prompt.txt, created on first use
VARIABLES_FILE = "variables.json"      # data/prompts/variables.json, your own {{variables}}
PROMPT_FREEZE = True                   # True: fill the prompt in once per conversation and store it
                                       # (keeps Ollama's prompt cache valid). False: refill every message.
CONTEXT_FALLBACK = 2048                # {{context_size}} if neither the Modelfile nor Ollama's settings say
CHAT_TIMEOUT = 600                     # seconds Ollama may stay silent (covers model load time)
CHAT_MAX_CHARS = 400000                # refuse to send a conversation larger than this
LOG_MAX_BYTES = 100 * 1024             # auto-truncated above this size
CREATE_TIMEOUT = 3600                  # seconds allowed for one "ollama create"
STATUS_POLL_SECONDS = 5                # how often the page refreshes VRAM and status
# ----------------------------------------------------------------------

if not DEBUG_MODE:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    flask_cli.show_server_banner = lambda *args, **kwargs: None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(BASE_DIR, "assets")


def _load_package():
    py_dir = os.path.join(ASSETS_DIR, "py")
    spec = importlib.util.spec_from_file_location(
        "omf", os.path.join(py_dir, "__init__.py"), submodule_search_locations=[py_dir])
    module = importlib.util.module_from_spec(spec)
    sys.modules["omf"] = module
    spec.loader.exec_module(module)
    return module


omf = _load_package()
cfg = omf.settings
cfg.DEBUG_MODE = DEBUG_MODE
cfg.LOG_FILE = os.path.join(BASE_DIR, "logs", LOG_FILENAME)
cfg.LOG_MAX_BYTES = LOG_MAX_BYTES
cfg.OLLAMA_URL = OLLAMA_URL
cfg.OLLAMA_BIN = OLLAMA_BIN
cfg.OLLAMA_SERVICE = OLLAMA_SERVICE
cfg.OLLAMA_DROPIN = OLLAMA_DROPIN
cfg.DEFAULT_MODELS_DIR = DEFAULT_MODELS_DIR
cfg.OLLAMA_STORE_FALLBACK = OLLAMA_STORE_FALLBACK
cfg.MODELFILE_DIR = os.path.join(BASE_DIR, "data", "modelfiles")
cfg.CHAT_DB = os.path.join(BASE_DIR, "data", "chat", CHAT_DB_FILENAME)
cfg.USER_NAME = USER_NAME
cfg.CHAR_NAME = CHAR_NAME
cfg.PROMPT_FILE = os.path.join(BASE_DIR, "data", "prompts", PROMPT_FILE)
cfg.VARIABLES_FILE = os.path.join(BASE_DIR, "data", "prompts", VARIABLES_FILE)
cfg.PROMPT_FREEZE = PROMPT_FREEZE
cfg.CONTEXT_FALLBACK = CONTEXT_FALLBACK
cfg.CHAT_TIMEOUT = CHAT_TIMEOUT
cfg.CHAT_MAX_CHARS = CHAT_MAX_CHARS
cfg.HELPER_PATH = os.path.join(ASSETS_DIR, "py", "root_helper.py")
cfg.CREATE_TIMEOUT = CREATE_TIMEOUT

S = omf.STRINGS
mf = omf.functions_modelfile
oll = omf.functions_ollama
sysf = omf.functions_system
gguf = omf.functions_gguf
logf = omf.functions_log
chatf = omf.functions_chat
promptf = omf.functions_prompt

app = Flask(__name__, static_folder=ASSETS_DIR, static_url_path="/assets")
ALLOWED_HOSTS = {"localhost", "127.0.0.1"}


@app.before_request
def guard():
    if (request.host or "").split(":")[0] not in ALLOWED_HOSTS:
        return jsonify(error=S["bad_host"]), 403
    if request.method == "POST" and not request.is_json:
        return jsonify(error=S["bad_json"]), 400


def fail(key, code=400, **extra):
    return jsonify(error=S.get(key, key), **extra), code


@app.route("/")
def index():
    return send_from_directory(os.path.join(ASSETS_DIR, "html"), "index.html")


@app.route("/api/config")
def api_config():
    return jsonify(
        default_models_dir=DEFAULT_MODELS_DIR,
        temperature=DEFAULT_TEMPERATURE,
        num_ctx=DEFAULT_CONTEXT,
        system=DEFAULT_SYSTEM_PROMPT,
        keep_alive=DEFAULT_KEEP_ALIVE,
        poll_seconds=STATUS_POLL_SECONDS,
        formats=mf.format_list(),
    )


@app.route("/api/status")
def api_status():
    env = sysf.service_env()
    return jsonify(
        state=sysf.service_state(),
        version=oll.version(),
        keep_alive=env.get("OLLAMA_KEEP_ALIVE", DEFAULT_KEEP_ALIVE),
        env={k: v for k, v in sorted(env.items()) if k.startswith("OLLAMA_")},
        vram=sysf.vram(),
        loaded=oll.loaded_models(),
    )


@app.route("/api/daemon", methods=["POST"])
def api_daemon():
    action = (request.json or {}).get("action")
    if action not in ("start", "stop", "restart"):
        return fail("bad_action")
    ok, msg = sysf.helper_call(action)
    logf.debug_log(f"daemon {action}: ok={ok} {msg}")
    if not ok:
        return fail("no_helper", 500, detail=msg)
    return jsonify(ok=True, state=sysf.service_state())


@app.route("/api/setting", methods=["POST"])
def api_setting():
    data = request.json or {}
    key, value = str(data.get("key", "")), str(data.get("value", "")).strip()
    rule = sysf.SETTING_RULES.get(key)
    if rule is None:
        return fail("bad_action")
    if not rule.match(value):
        return fail("bad_setting")
    ok, msg = sysf.helper_call("set-env", key, value)
    if not ok:
        return fail("no_helper", 500, detail=msg)
    logf.log_event(f"SETTING {key}={value} (daemon restarted)")
    return jsonify(ok=True, key=key, value=value)


@app.route("/api/unload", methods=["POST"])
def api_unload():
    model = str((request.json or {}).get("model", ""))
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    return jsonify(ok=oll.unload(model))


@app.route("/api/gguf-files")
def api_gguf_files():
    root = os.path.realpath(os.path.expanduser(request.args.get("dir") or DEFAULT_MODELS_DIR))
    files = []
    if os.path.isdir(root):
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath[len(root):].count(os.sep) >= 2:
                dirnames[:] = []
            for fn in filenames:
                if fn.lower().endswith(".gguf"):
                    full = os.path.join(dirpath, fn)
                    files.append({"path": full, "name": fn,
                                  "size_mb": round(os.path.getsize(full) / 1048576)})
    files.sort(key=lambda f: f["name"].lower())
    return jsonify(dir=root, files=files[:500], format_guess={f["path"]: mf.detect_format(f["name"]) for f in files[:500]})


@app.route("/api/modelfile/preview", methods=["POST"])
def api_modelfile_preview():
    clean, err = mf.validate(request.json or {})
    if err:
        return fail(err)
    return jsonify(text=mf.build(clean), format=clean["format"])


@app.route("/api/modelfile/create", methods=["POST"])
def api_modelfile_create():
    clean, err = mf.validate(request.json or {})
    if err:
        return fail(err)
    reason = gguf.unsupported_reason(clean["path"])
    if reason:
        logf.debug_log(f"unsupported gguf: {clean['path']}")
        return jsonify(error=reason), 422
    path = mf.write(clean)
    logf.debug_log(f"modelfile written: {path}")
    return jsonify(path=path, text=mf.build(clean))


@app.route("/api/models")
def api_models():
    models, err = oll.list_models()
    if models is None:
        return fail(err, 502)
    return jsonify(models=models)


@app.route("/api/models/create", methods=["POST"])
def api_models_create():
    data = request.json or {}
    clean, err = mf.validate(data)
    if err:
        return fail(err)
    reason = gguf.unsupported_reason(clean["path"])
    if reason:
        return jsonify(error=reason), 422
    modelfile_path = os.path.join(cfg.MODELFILE_DIR, mf.safe_filename(clean["name"]))
    if not os.path.isfile(modelfile_path):
        return fail("modelfile_missing")
    if oll.model_exists(clean["name"]) and not data.get("overwrite"):
        return fail("exists", 409)
    store = sysf.store_dir()
    free = sysf.disk_free(store) if store else None
    if free is not None and free < os.path.getsize(clean["path"]) * 1.05:
        return fail("disk_low", 507)
    job_id = oll.start_create(clean["name"], modelfile_path, clean["path"])
    return jsonify(job=job_id)


@app.route("/api/models/load", methods=["POST"])
def api_models_load():
    model = str((request.json or {}).get("model", ""))
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    if not oll.version():
        return fail("daemon_down", 502)
    return jsonify(job=oll.start_load(model))


@app.route("/api/jobs/<job_id>")
def api_job(job_id):
    job = oll.job_status(job_id)
    if job is None:
        return fail("not_found", 404)
    return jsonify(job)


@app.route("/api/models/remove", methods=["POST"])
def api_models_remove():
    model = str((request.json or {}).get("model", ""))
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    ok, msg = oll.remove(model)
    if not ok:
        return fail(msg or "remove failed", 502)
    return jsonify(ok=True, message=S["model_removed"])


@app.route("/api/models/show")
def api_models_show():
    model = request.args.get("name", "")
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    text, err = oll.show_modelfile(model)
    if text is None:
        return fail(err or "show failed", 502)
    return jsonify(text=text)


# ----- chat -----
def _chat_input(data, need_user_last=False):
    """Validate model and messages from a request body. Returns (model, messages, error_key)."""
    model = str(data.get("model", ""))
    if not mf.NAME_RE.match(model):
        return None, None, "bad_name"
    messages = chatf.clean_messages(data.get("messages"))
    if messages is None or (need_user_last and (not messages or messages[-1]["role"] != "user")):
        return None, None, "bad_messages"
    if sum(len(m["content"]) for m in messages) > CHAT_MAX_CHARS:
        return None, None, "chat_too_long"
    return model, messages, None


@app.route("/api/chat/send", methods=["POST"])
def api_chat_send():
    model, messages, err = _chat_input(request.json or {}, need_user_last=True)
    if err:
        return fail(err)
    if not oll.version():
        return fail("daemon_down", 502)

    # The system prompt comes from data/prompts/prompt.txt. A conversation that already has
    # one keeps it, so the start of the prompt never changes and Ollama can reuse its cache.
    system_text = None
    if messages[0]["role"] != "system":
        system_text = promptf.render(model)
        if system_text:
            messages = [{"role": "system", "content": system_text}] + messages

    def generate():
        stream = oll.stream_chat(model, messages)
        try:
            if system_text and cfg.PROMPT_FREEZE:
                yield json.dumps({"system": system_text}) + "\n"
            for item in stream:
                yield json.dumps(item) + "\n"
        finally:
            stream.close()   # browser stopped or left: close the upstream request

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/prompt")
def api_prompt():
    model = request.args.get("model", "")
    if model and not mf.NAME_RE.match(model):
        return fail("bad_name")
    return jsonify(rendered=promptf.render(model), variables=promptf.all_values(model),
                   descriptions=promptf.descriptions(), file=cfg.PROMPT_FILE,
                   variables_file=cfg.VARIABLES_FILE, frozen=cfg.PROMPT_FREEZE)


@app.route("/api/chat/conversations")
def api_chat_conversations():
    model = request.args.get("model", "")
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    return jsonify(conversations=chatf.list_conversations(model))


@app.route("/api/chat/conversation/<int:conv_id>")
def api_chat_conversation(conv_id):
    conv = chatf.get_conversation(conv_id)
    if conv is None:
        return fail("not_found", 404)
    return jsonify(conv)


@app.route("/api/chat/save", methods=["POST"])
def api_chat_save():
    data = request.json or {}
    model, messages, err = _chat_input(data)
    if err:
        return fail(err)
    if not messages:
        return fail("chat_empty")
    conv_id = data.get("id")
    if conv_id is not None and (not isinstance(conv_id, int) or isinstance(conv_id, bool)):
        return fail("bad_messages")
    saved = chatf.save_conversation(model, messages, conv_id)
    if saved is None:
        return fail("not_found", 404)
    return jsonify(ok=True, id=saved)


@app.route("/api/chat/delete", methods=["POST"])
def api_chat_delete():
    conv_id = (request.json or {}).get("id")
    if not isinstance(conv_id, int) or isinstance(conv_id, bool):
        return fail("bad_messages")
    return jsonify(ok=chatf.delete_conversation(conv_id))


@app.route("/api/chat/clear", methods=["POST"])
def api_chat_clear():
    model = str((request.json or {}).get("model", ""))
    if not mf.NAME_RE.match(model):
        return fail("bad_name")
    return jsonify(ok=True, removed=chatf.clear_model(model))


@app.route("/api/log")
def api_log():
    return jsonify(text=logf.read_log())


def find_free_port(start, tries):
    for port in range(start, start + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((HOST, port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port between {start} and {start + tries - 1}")


if __name__ == "__main__":
    chosen = find_free_port(PORT, PORT_TRIES)
    print(f"Ollama Manager: http://{HOST}:{chosen}/", flush=True)
    logf.debug_log(f"starting on port {chosen}")
    app.run(host=HOST, port=chosen, debug=False, threaded=True)
