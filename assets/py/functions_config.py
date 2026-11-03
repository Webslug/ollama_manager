"""Shared settings object. app.py fills it in from its top-of-file constants."""
from types import SimpleNamespace

settings = SimpleNamespace(
    DEBUG_MODE=False,
    LOG_FILE=None,
    LOG_MAX_BYTES=100 * 1024,
    OLLAMA_URL="http://127.0.0.1:11434",
    OLLAMA_BIN="ollama",
    OLLAMA_SERVICE="ollama",
    DEFAULT_MODELS_DIR="",
    OLLAMA_STORE_FALLBACK="",
    MODELFILE_DIR=None,
    CHAT_DB=None,
    USER_NAME="User",
    CHAR_NAME="Assistant",
    PROMPT_FILE=None,
    VARIABLES_FILE=None,
    PROMPT_FREEZE=True,
    CONTEXT_FALLBACK=2048,
    CHAT_TIMEOUT=600,
    CHAT_MAX_CHARS=400000,
    HELPER_PATH="/usr/local/sbin/ollama-manager-helper",
    CREATE_TIMEOUT=3600,
)
