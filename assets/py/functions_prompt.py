"""System prompt template. Reads data/prompts/prompt.txt and fills in {{variables}}.

Two ways to add a variable:
  1. No code: put it in data/prompts/variables.json, e.g. {"path_1": "/media/storage"} or
     {"paths": ["/a", "/b"]}. A list also gives {{paths_1}}, {{paths_2}}... and {{paths_count}}.
     Variables in that file override built-in ones of the same name.
  2. Code: add a function below with the @variable("name", "description") decorator. It receives a
     Context and returns text. It only runs when the template actually uses it.
"""
import json
import os
import platform
import re
import socket

from datetime import datetime

from . import functions_ollama as oll
from . import functions_system as sysf
from .functions_config import settings
from .functions_log import debug_log

UNKNOWN = "unknown"
_TOKEN = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

DEFAULT_PROMPT = """You are {{char}}, a friendly, helpful and honest AI assistant. You are talking with {{user}}.

It is {{weekday}} {{date_long}}, {{time}} ({{part_of_day}}), time zone {{timezone}}.
You are running as the model {{model}} ({{model_params}}, {{model_quant}}) through Ollama on {{user}}'s own computer, with a context window of {{context_size}} tokens. Nothing you say leaves this machine.

Be direct and accurate. If you do not know something, say so.
"""

DEFAULT_VARIABLES = {
    "paths": ["/media/storage/backup/AI/Models/"],
}

VARIABLES = {}      # name -> (function, description)


def variable(name, description=""):
    def register(fn):
        VARIABLES[name] = (fn, description)
        return fn
    return register


class Context:
    """What a variable function can look at. Ollama is only asked if a variable needs it."""

    def __init__(self, model):
        self.model = model or ""
        self.now = datetime.now().astimezone()
        self._info = None

    @property
    def info(self):
        if self._info is None:
            reply = oll.api("/api/show", {"model": self.model, "name": self.model}, timeout=10) if self.model else None
            self._info = reply or {}
        return self._info

    def parameter(self, key):
        for line in (self.info.get("parameters") or "").splitlines():
            parts = line.split(None, 1)
            if len(parts) == 2 and parts[0] == key:
                return parts[1].strip()
        return None


# ---------- built-in variables: people and model ----------
@variable("user", "Your name, USER_NAME in app.py")
def _user(ctx): return settings.USER_NAME

@variable("char", "The AI character name, CHAR_NAME in app.py")
def _char(ctx): return settings.CHAR_NAME

@variable("model", "Full model name, e.g. qwen3:latest")
def _model(ctx): return ctx.model

@variable("model_base", "Model name without the :tag")
def _model_base(ctx): return ctx.model.split(":")[0]

@variable("model_tag", "The :tag part of the model name")
def _model_tag(ctx): return ctx.model.split(":", 1)[1] if ":" in ctx.model else "latest"

@variable("model_family", "Architecture family from the GGUF, e.g. qwen35")
def _model_family(ctx): return (ctx.info.get("details") or {}).get("family")

@variable("model_params", "Parameter count, e.g. 9.0B")
def _model_params(ctx): return (ctx.info.get("details") or {}).get("parameter_size")

@variable("model_quant", "Quantisation, e.g. Q6_K")
def _model_quant(ctx): return (ctx.info.get("details") or {}).get("quantization_level")

@variable("context_size", "Context window in tokens: Modelfile num_ctx, else OLLAMA_NUM_CTX, else the fallback")
def _context_size(ctx):
    return (ctx.parameter("num_ctx") or sysf.service_env().get("OLLAMA_NUM_CTX")
            or settings.CONTEXT_FALLBACK)

@variable("temperature", "Temperature from the Modelfile, if it sets one")
def _temperature(ctx): return ctx.parameter("temperature")


# ---------- built-in variables: date and time ----------
@variable("time", "24 hour time, 14:05")
def _time(ctx): return ctx.now.strftime("%H:%M")

@variable("time_12", "12 hour time, 2:05 PM")
def _time_12(ctx): return ctx.now.strftime("%I:%M %p").lstrip("0")

@variable("time_seconds", "Time with seconds, 14:05:09")
def _time_seconds(ctx): return ctx.now.strftime("%H:%M:%S")

@variable("hour", "Hour, 0 to 23")
def _hour(ctx): return ctx.now.hour

@variable("minute", "Minute, 0 to 59")
def _minute(ctx): return ctx.now.minute

@variable("part_of_day", "morning, afternoon, evening or night")
def _part_of_day(ctx):
    h = ctx.now.hour
    return "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 17 else "evening" if 17 <= h < 21 else "night"

@variable("date", "Date, 2026-11-03")
def _date(ctx): return ctx.now.strftime("%Y-%m-%d")

@variable("date_long", "Date, 3rd November 2026")
def _date_long(ctx): return f"{_day_ordinal(ctx)} {ctx.now.strftime('%B %Y')}"

@variable("date_uk", "Date, 03/11/2026")
def _date_uk(ctx): return ctx.now.strftime("%d/%m/%Y")

@variable("weekday", "Monday, Tuesday, ...")
def _weekday(ctx): return ctx.now.strftime("%A")

@variable("weekday_short", "Mon, Tue, ...")
def _weekday_short(ctx): return ctx.now.strftime("%a")

@variable("weekday_number", "1 (Monday) to 7 (Sunday)")
def _weekday_number(ctx): return ctx.now.isoweekday()

@variable("is_weekend", "yes on Saturday and Sunday, otherwise no")
def _is_weekend(ctx): return "yes" if ctx.now.isoweekday() >= 6 else "no"

@variable("day", "Day of the month, 3")
def _day(ctx): return ctx.now.day

@variable("day_ordinal", "Day of the month, 3rd")
def _day_ordinal(ctx):
    n = ctx.now.day
    return f"{n}{'th' if 11 <= n % 100 <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"

@variable("day_of_year", "1 to 366")
def _day_of_year(ctx): return ctx.now.timetuple().tm_yday

@variable("week_number", "ISO week number, 1 to 53")
def _week_number(ctx): return ctx.now.isocalendar()[1]

@variable("month", "Month number, 11")
def _month(ctx): return ctx.now.month

@variable("month_name", "November")
def _month_name(ctx): return ctx.now.strftime("%B")

@variable("month_short", "Nov")
def _month_short(ctx): return ctx.now.strftime("%b")

@variable("quarter", "Calendar quarter, 1 to 4")
def _quarter(ctx): return (ctx.now.month - 1) // 3 + 1

@variable("year", "2026")
def _year(ctx): return ctx.now.year

@variable("datetime", "ISO 8601 date and time with offset")
def _datetime(ctx): return ctx.now.isoformat(timespec="seconds")

@variable("timestamp", "Unix timestamp in seconds")
def _timestamp(ctx): return int(ctx.now.timestamp())

@variable("timezone", "Time zone abbreviation, e.g. GMT")
def _timezone(ctx): return ctx.now.tzname()

@variable("utc_offset", "Offset from UTC, +0000")
def _utc_offset(ctx): return ctx.now.strftime("%z")


# ---------- built-in variables: machine ----------
@variable("hostname", "This computer's name")
def _hostname(ctx): return socket.gethostname()

@variable("os", "Operating system and kernel")
def _os(ctx): return f"{platform.system()} {platform.release()}"

@variable("gpu", "GPU name and total VRAM")
def _gpu(ctx):
    v = sysf.vram()
    return f"{v['name']} ({v['total_mb'] // 1024} GB)" if v.get("available") else None

@variable("ollama_version", "Ollama daemon version")
def _ollama_version(ctx): return oll.version()


# ---------- files and rendering ----------
def _match_owner(path):
    """Under run.sh the app is root; hand new files to the owner of data/ so Kim can edit them."""
    try:
        if os.geteuid() == 0:
            st = os.stat(os.path.dirname(os.path.dirname(settings.PROMPT_FILE)))
            os.chown(path, st.st_uid, st.st_gid)
            os.chown(os.path.dirname(path), st.st_uid, st.st_gid)
    except OSError:
        pass


def _ensure_file(path, text):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    _match_owner(path)
    debug_log(f"prompt file created: {path}")


def load_template():
    _ensure_file(settings.PROMPT_FILE, DEFAULT_PROMPT)
    try:
        with open(settings.PROMPT_FILE, encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        debug_log(f"prompt read failed, using default: {exc}")
        return DEFAULT_PROMPT


def load_custom():
    """Read variables.json into a flat {name: text} dict. Bad entries are skipped."""
    _ensure_file(settings.VARIABLES_FILE, json.dumps(DEFAULT_VARIABLES, indent=2) + "\n")
    try:
        with open(settings.VARIABLES_FILE, encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as exc:
        debug_log(f"variables.json unreadable: {exc}")
        return {}
    out = {}
    if not isinstance(raw, dict):
        return out

    def text(value):
        return "yes" if value is True else "no" if value is False else str(value)

    for name, value in raw.items():
        if not _NAME.match(str(name)):
            continue
        if isinstance(value, (str, int, float, bool)):
            out[name] = text(value)
        elif isinstance(value, list):
            items = [text(v) for v in value if isinstance(v, (str, int, float, bool))]
            out[name] = "\n".join(items)
            out[name + "_count"] = str(len(items))
            for i, item in enumerate(items, 1):
                out[f"{name}_{i}"] = item
    return out


def _evaluate(name, ctx, custom):
    if name in custom:
        return custom[name]
    entry = VARIABLES.get(name)
    if entry is None:
        return None
    try:
        value = entry[0](ctx)
    except Exception as exc:        # a broken variable must not break the chat
        debug_log(f"variable {name} failed: {exc}")
        value = None
    return UNKNOWN if value in (None, "") else str(value)


def render(model):
    """The finished system prompt for this model. Unknown {{names}} are left as typed."""
    ctx, custom = Context(model), load_custom()

    def sub(match):
        value = _evaluate(match.group(1), ctx, custom)
        if value is None:
            debug_log(f"unknown prompt variable: {match.group(1)}")
            return match.group(0)
        return value

    return _TOKEN.sub(sub, load_template()).strip()


def all_values(model):
    """Every variable and its value right now, for the preview window."""
    ctx, custom = Context(model), load_custom()
    names = list(VARIABLES) + [n for n in custom if n not in VARIABLES]
    return {n: _evaluate(n, ctx, custom) for n in names}


def descriptions():
    return {n: d for n, (_, d) in VARIABLES.items()}
