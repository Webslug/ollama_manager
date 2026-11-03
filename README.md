<p align="center">
  <img src="assets/img/main.jpg" alt="Ollama Manager: the Add a .gguf model form" width="900">
</p>

<h1 align="center">Ollama Manager</h1>

<p align="center">
  A small Flask web app that makes adding, removing and tuning <a href="https://ollama.com">Ollama</a> models painless.<br>
  No more hand-writing Modelfiles.
</p>

---

## What it does

- **Add a .gguf model** by filling in a form. It builds the Modelfile for you, shows a live preview, and adds the model to Ollama behind a progress modal.
- **Prompt formats built in:** auto-detect from the file name, or choose ChatML, Llama 3, Mistral, Gemma, Phi-3, Alpaca, or the template embedded in the GGUF.
- **Browse** the `.gguf` files in your models folder.
- **Installed models:** list, view the Modelfile, copy the name, and remove (with a confirmation dialog).
- **Daemon controls:** start, stop and restart the Ollama service, with a live VRAM progress bar.
- **Quick unload and reload:** an Unload button and a "Load last model" button sit with the daemon controls. The last model you had in memory is remembered in your browser.
- **Chat:** talk to any installed or loaded model from the page. Replies stream in, code blocks get a copy button, and the conversation window can be expanded. See [Chat](#chat) below.
- **Timeout and memory:** change how long idle models stay loaded, see what is in memory, and unload a model on demand.
- **Settings:** flash attention, KV cache type, parallel requests and max loaded models.
- **Cheat sheet** of useful Ollama commands with copy buttons, and an activity log of every model added or removed, with a Clear log button.
- Ten colour themes, large buttons and styled tooltips, built on Bootstrap 5 and Bootstrap Icons.

## Requirements

- Linux with systemd (developed on Lubuntu 22.04)
- [Ollama](https://ollama.com) installed as a systemd service named `ollama`
- Python 3.10+ and Flask (`pip install flask`)
- `zenity`, only if you use `run.sh` (for the password prompt)
- An NVIDIA GPU with `nvidia-smi`, only for the VRAM bar (everything else works without it)

Windows and macOS are not supported. The daemon controls rely on systemd and the launcher on `sudo` and `zenity`, so a port would need a substantial rework.

## Quick start

```bash
git clone <your-repo-url> ollama-manager
cd ollama-manager
./run.sh
```

Then open the address it prints, normally <http://127.0.0.1:5782/>. If port 5782 is busy, the app tries the next free port.

### Two ways to launch

| Command | Daemon start/stop/restart and settings | Everything else |
|---|---|---|
| `./run.sh` | Works. Asks for your sudo password in a dialog, then runs the app as root. | Works |
| `python3 app.py` | Disabled, because the app needs root to control a system service. | Works |

When launched with `run.sh`, files the app creates in `logs/` and `data/` are handed back to your user when it exits.

## Configuration

The constants at the top of `app.py` are meant to be tweaked:

| Constant | Purpose |
|---|---|
| `DEBUG_MODE` | `False` keeps the console quiet. `True` prints request logs and writes extra audit lines to the log file. |
| `PORT`, `PORT_TRIES` | Starting port and how many following ports to try. |
| `DEFAULT_MODELS_DIR` | Where the Browse button looks for `.gguf` files. |
| `DEFAULT_TEMPERATURE`, `DEFAULT_CONTEXT`, `DEFAULT_SYSTEM_PROMPT` | Form defaults. |
| `LOG_MAX_BYTES` | The log is trimmed to its newest half once it exceeds this size (100 KB by default). |
| `USER_NAME`, `CHAR_NAME` | The values of `{{user}}` and `{{char}}` in the system prompt. |
| `PROMPT_FILE`, `VARIABLES_FILE` | File names inside `data/prompts/`. |
| `PROMPT_FREEZE` | `True` fills the system prompt in once per conversation. `False` refills it every message. |
| `CONTEXT_FALLBACK` | Value of `{{context_size}}` when neither the Modelfile nor Ollama's settings give one. |
| `CHAT_DB_FILENAME`, `CHAT_TIMEOUT`, `CHAT_MAX_CHARS` | Chat database name, seconds Ollama may stay silent, and the largest conversation the app will send. |

Form values, the auto-save choice and the last loaded model are remembered in your browser's local storage.

## Project layout

```
app.py              entry point and constants
run.sh              launcher with a zenity sudo prompt
assets/
  html/             the single page
  css/              Bootstrap plus modular, token-based CSS and themes
  js/               page logic
  py/               helper modules (functions_*.py) and the root helper
  img/              README image
docs/               extra documentation (prompt variables)
logs/               ollama_manager.log (created on demand, git-ignored)
data/
  chat/             chat.sqlite, the saved conversations (created on demand, never pushed)
  modelfiles/       generated Modelfiles (never pushed)
  prompts/          prompt.txt and variables.json (pushed)
```

## Chat

The Chat section sits after the installed models list, with its own link in the navbar.

- Pick a model (models already in memory are listed first), type a message, press Enter. Shift+Enter adds a new line. Stop ends a reply early.
- **Code blocks:** fenced code in a reply is shown in a box with the language name and a copy button.
- **Window size:** drag the bottom-right corner of the conversation window, or use the Expand button.
- **New conversation, Save conversation, Clear saved conversations:** Clear deletes every saved conversation for the selected model, after a confirmation.
- **Save conversations automatically:** off by default. Your choice is remembered in the browser.
- **Saved conversations** are listed for the selected model. Open one to continue it, or delete it.
- Saved conversations live in a SQLite database, `data/chat/chat.sqlite`, created on first use. It is never pushed to Git.
- Messages are stored exactly as the model wrote them. Code blocks are drawn when a message is displayed.

### System prompt and variables

Every conversation starts with the system prompt in `data/prompts/prompt.txt`. It is created with a default on first use. Write `{{name}}` anywhere in it and the app fills in the value, for example `{{weekday}}`, `{{date}}`, `{{time}}`, `{{model}}`, `{{context_size}}`, `{{user}}` and `{{char}}`.

- The "System prompt" button shows the filled-in prompt and every variable with its current value.
- Add your own variables, such as `{{path_1}}`, without code in `data/prompts/variables.json`. A list also gives `{{name_1}}`, `{{name_2}}` and `{{name_count}}`.
- The prompt is filled in once when a conversation starts and stored with it, so the time means "when the conversation began". This keeps Ollama's prompt cache valid. Set `PROMPT_FREEZE = False` to refill it on every message.
- The chat prompt replaces the Modelfile's SYSTEM line. Temperature and context still come from the Modelfile.
- Full variable list: [docs/prompt_variables.md](docs/prompt_variables.md).

## Security notes

- The server binds to `127.0.0.1` only and rejects requests whose `Host` header is not localhost.
- Every POST must be JSON, which blocks simple cross-site form posts.
- Chat history stays on your machine. `.gitignore` excludes the database, and `push.sh` refuses to commit anything under `data/chat/`, `data/modelfiles/` or any `.sqlite` or `.db` file.
- Model names, paths and settings are validated, and no shell is ever used to run commands.
- Root actions go through a small helper that accepts only `start`, `stop`, `restart` and a whitelist of five Ollama settings.
- Running the app as root is a deliberate convenience. Keep it on a machine and network you trust.

## Notes

- Adding a model only runs `ollama create`, and removing one only runs `ollama rm`. Neither loads or runs a model. Loading a model, or pressing Send in the Chat section, does use your GPU.
- `data/prompts/variables.json` is pushed with the project. Do not put anything private in it.
- Changing a daemon setting restarts Ollama, which unloads any loaded model. The app asks you to confirm first.
- Settings are written to a systemd drop-in, `/etc/systemd/system/ollama.service.d/zz-manager.conf`.
