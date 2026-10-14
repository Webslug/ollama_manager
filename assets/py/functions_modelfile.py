"""Modelfile construction, prompt formats and input validation."""
import os
import re

from .functions_config import settings

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$")

CHATML = (
    '{{ if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n{{ end }}'
    '{{ if .Prompt }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n{{ end }}'
    '<|im_start|>assistant\n{{ .Response }}<|im_end|>\n'
)
LLAMA3 = (
    '{{ if .System }}<|start_header_id|>system<|end_header_id|>\n\n{{ .System }}<|eot_id|>{{ end }}'
    '{{ if .Prompt }}<|start_header_id|>user<|end_header_id|>\n\n{{ .Prompt }}<|eot_id|>{{ end }}'
    '<|start_header_id|>assistant<|end_header_id|>\n\n{{ .Response }}<|eot_id|>'
)
MISTRAL = '[INST] {{ if .System }}{{ .System }} {{ end }}{{ .Prompt }} [/INST]{{ .Response }}</s>'
GEMMA = (
    '<start_of_turn>user\n{{ if .System }}{{ .System }} {{ end }}{{ .Prompt }}<end_of_turn>\n'
    '<start_of_turn>model\n{{ .Response }}<end_of_turn>\n'
)
PHI3 = (
    '{{ if .System }}<|system|>\n{{ .System }}<|end|>\n{{ end }}'
    '{{ if .Prompt }}<|user|>\n{{ .Prompt }}<|end|>\n{{ end }}'
    '<|assistant|>\n{{ .Response }}<|end|>\n'
)
ALPACA = (
    '{{ if .System }}{{ .System }}\n\n{{ end }}### Instruction:\n{{ .Prompt }}\n\n'
    '### Response:\n{{ .Response }}'
)

FORMATS = {
    "builtin": {"label": "Use GGUF built-in template (modern models)", "template": None, "stop": []},
    "chatml": {"label": "ChatML (Qwen, Dolphin, Hermes, Yi)", "template": CHATML,
               "stop": ["<|im_start|>", "<|im_end|>"]},
    "llama3": {"label": "Llama 3 / 3.1", "template": LLAMA3,
               "stop": ["<|start_header_id|>", "<|end_header_id|>", "<|eot_id|>"]},
    "mistral": {"label": "Mistral / Mixtral [INST]", "template": MISTRAL,
                "stop": ["[INST]", "[/INST]"]},
    "gemma": {"label": "Gemma", "template": GEMMA,
              "stop": ["<start_of_turn>", "<end_of_turn>"]},
    "phi3": {"label": "Phi-3", "template": PHI3,
             "stop": ["<|end|>", "<|user|>", "<|assistant|>", "<|system|>"]},
    "alpaca": {"label": "Alpaca", "template": ALPACA,
               "stop": ["### Instruction:", "### Response:"]},
}

DETECT = [
    ("chatml", ("qwen", "dolphin", "chatml", "hermes", "yi-", "smollm", "openhermes")),
    ("llama3", ("llama-3", "llama3", "llama_3")),
    ("mistral", ("mistral", "mixtral")),
    ("gemma", ("gemma",)),
    ("phi3", ("phi-3", "phi3", "phi_3")),
    ("alpaca", ("alpaca",)),
]


def detect_format(filename):
    lowered = os.path.basename(filename).lower()
    for key, needles in DETECT:
        if any(n in lowered for n in needles):
            return key
    return "builtin"


def format_list():
    return [{"key": k, "label": v["label"]} for k, v in FORMATS.items()]


def validate(data):
    """Return (clean_dict, error_key). error_key is a STRINGS key or None."""
    name = str(data.get("name", "")).strip()
    if not NAME_RE.match(name):
        return None, "bad_name"

    path = os.path.realpath(os.path.expanduser(str(data.get("path", "")).strip()))
    if not (path.lower().endswith(".gguf") and os.path.isfile(path) and os.access(path, os.R_OK)):
        return None, "bad_path"

    try:
        temperature = float(data.get("temperature", 0.7))
    except (TypeError, ValueError):
        return None, "bad_temp"
    if not 0 <= temperature <= 2:
        return None, "bad_temp"

    raw_ctx = str(data.get("num_ctx", "")).strip()
    if not raw_ctx.isdigit() or not 128 <= int(raw_ctx) <= 1048576:
        return None, "bad_ctx"

    system = str(data.get("system", ""))
    if '"""' in system:
        return None, "bad_prompt"

    fmt = str(data.get("format", "")).strip() or detect_format(path)
    if fmt not in FORMATS:
        return None, "bad_format"

    return {
        "name": name, "path": path, "temperature": temperature,
        "num_ctx": int(raw_ctx), "system": system, "format": fmt,
    }, None


def build(clean):
    fmt = FORMATS[clean["format"]]
    parts = [f"FROM {clean['path']}", ""]
    if fmt["template"] is not None:
        parts.append(f"# Prompt format: {fmt['label']}")
        parts.append('TEMPLATE """' + fmt["template"] + '"""')
        parts.append("")
        for token in fmt["stop"]:
            parts.append(f'PARAMETER stop "{token}"')
    parts.append(f"PARAMETER num_ctx {clean['num_ctx']}")
    parts.append(f"PARAMETER temperature {clean['temperature']}")
    if clean["system"].strip():
        parts.append("")
        parts.append('SYSTEM """' + clean["system"].strip() + '"""')
    return "\n".join(parts) + "\n"


def safe_filename(name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", name) + ".Modelfile"


def write(clean):
    os.makedirs(settings.MODELFILE_DIR, exist_ok=True)
    path = os.path.join(settings.MODELFILE_DIR, safe_filename(clean["name"]))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(build(clean))
    return path
