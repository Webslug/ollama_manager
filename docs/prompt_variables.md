# System prompt variables

Every chat in the Ollama Manager starts with the system prompt in `data/prompts/prompt.txt`.
Write `{{name}}` anywhere in it and the app fills in the value. The file is created with a
default on first use, and edits apply to the next new conversation (no restart needed).

The prompt is filled in once, when a conversation starts, and stored with that conversation.
Time and date therefore mean "when this conversation began". This keeps the start of the prompt
identical on every message, so Ollama can reuse its prompt cache. Set `PROMPT_FREEZE = False` in
`app.py` to refill it on every message instead (slower on long conversations).

The "System prompt" button in the Chat section shows the filled-in prompt and every variable's
current value.

## Adding your own variables

Without code: edit `data/prompts/variables.json`.

```json
{
  "path_1": "/media/storage/backup/AI/Models/",
  "project": "Ollama Manager",
  "paths": ["/home/kim/projects", "/media/storage"]
}
```

- A text, number or true/false value becomes `{{name}}`.
- A list becomes `{{paths}}` (one per line), `{{paths_1}}`, `{{paths_2}}` and `{{paths_count}}`.
- Names use letters, digits and underscores, and cannot start with a digit.
- Your variables override built-in ones of the same name.
- Unknown `{{names}}` are left as typed so mistakes are easy to spot.

With code: add a function to `assets/py/functions_prompt.py`.

```python
@variable("battery", "Laptop battery level")
def _battery(ctx):
    return "81%"
```

It only runs when the prompt uses it. `ctx.model` is the model name and `ctx.now` is the start time.

## Built-in variables

| Variable | Meaning |
| --- | --- |
| `{{user}}` | Your name, USER_NAME in app.py |
| `{{char}}` | The AI character name, CHAR_NAME in app.py |
| `{{model}}` | Full model name, e.g. qwen3:latest |
| `{{model_base}}` | Model name without the :tag |
| `{{model_tag}}` | The :tag part of the model name |
| `{{model_family}}` | Architecture family from the GGUF, e.g. qwen35 |
| `{{model_params}}` | Parameter count, e.g. 9.0B |
| `{{model_quant}}` | Quantisation, e.g. Q6_K |
| `{{context_size}}` | Context window in tokens: Modelfile num_ctx, else OLLAMA_NUM_CTX, else the fallback |
| `{{temperature}}` | Temperature from the Modelfile, if it sets one |
| `{{time}}` | 24 hour time, 14:05 |
| `{{time_12}}` | 12 hour time, 2:05 PM |
| `{{time_seconds}}` | Time with seconds, 14:05:09 |
| `{{hour}}` | Hour, 0 to 23 |
| `{{minute}}` | Minute, 0 to 59 |
| `{{part_of_day}}` | morning, afternoon, evening or night |
| `{{date}}` | Date, 2026-11-03 |
| `{{date_long}}` | Date, 3rd November 2026 |
| `{{date_uk}}` | Date, 03/11/2026 |
| `{{weekday}}` | Monday, Tuesday, ... |
| `{{weekday_short}}` | Mon, Tue, ... |
| `{{weekday_number}}` | 1 (Monday) to 7 (Sunday) |
| `{{is_weekend}}` | yes on Saturday and Sunday, otherwise no |
| `{{day}}` | Day of the month, 3 |
| `{{day_ordinal}}` | Day of the month, 3rd |
| `{{day_of_year}}` | 1 to 366 |
| `{{week_number}}` | ISO week number, 1 to 53 |
| `{{month}}` | Month number, 11 |
| `{{month_name}}` | November |
| `{{month_short}}` | Nov |
| `{{quarter}}` | Calendar quarter, 1 to 4 |
| `{{year}}` | 2026 |
| `{{datetime}}` | ISO 8601 date and time with offset |
| `{{timestamp}}` | Unix timestamp in seconds |
| `{{timezone}}` | Time zone abbreviation, e.g. GMT |
| `{{utc_offset}}` | Offset from UTC, +0000 |
| `{{hostname}}` | This computer's name |
| `{{os}}` | Operating system and kernel |
| `{{gpu}}` | GPU name and total VRAM |
| `{{ollama_version}}` | Ollama daemon version |
