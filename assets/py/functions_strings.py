"""English message strings for server responses (localisation point)."""

STRINGS = {
    "bad_json": "Request body must be JSON.",
    "bad_host": "Requests are only accepted from localhost.",
    "bad_name": "Model name may only use letters, digits and . _ : / - (max 100 characters).",
    "bad_path": "That path is not a readable .gguf file.",
    "bad_temp": "Temperature must be a number between 0 and 2.",
    "bad_ctx": "Context size must be a whole number between 128 and 1048576.",
    "bad_prompt": "The system prompt cannot contain three double quotes in a row.",
    "bad_format": "Unknown prompt format.",
    "bad_setting": "That value is not allowed for this setting. Timeouts look like 15m, 2h, 300s, 0 or -1.",
    "bad_action": "Unknown action.",
    "no_helper": "Daemon controls need root. Please start the app with ./run.sh instead.",
    "modelfile_missing": "Create the Modelfile first.",
    "exists": "A model with that name already exists. Confirm to overwrite it.",
    "disk_low": "Not enough free disk space in the Ollama model store for this model.",
    "not_found": "Not found.",
    "daemon_down": "The Ollama daemon is not running.",
    "model_added": "Model added to Ollama.",
    "model_removed": "Model removed from Ollama.",
}
