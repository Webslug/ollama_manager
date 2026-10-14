#!/bin/bash
# Launch Ollama Manager as root so the daemon controls work.
# A zenity dialog asks for your sudo password every time, then the Flask app starts.
set -u

cd "$(dirname "$(readlink -f "$0")")" || exit 1

if [ "$(id -u)" -eq 0 ]; then
  echo "Please run ./run.sh as your normal user. It asks for the sudo password itself." >&2
  exit 1
fi

APP_UID="$(id -u)"
APP_GID="$(id -g)"
USER_SITE="$(python3 -m site --user-site)"

mkdir -p logs data

ASKPASS="$(mktemp)"
trap 'rm -f "$ASKPASS"' EXIT
cat > "$ASKPASS" <<'EOF'
#!/bin/bash
exec zenity --password --title="Ollama Manager" 2>/dev/null
EOF
chmod 700 "$ASKPASS"
export SUDO_ASKPASS="$ASKPASS"

sudo -k
if ! sudo -A -v; then
  zenity --error --title="Ollama Manager" --text="The password was not accepted, so nothing was started." 2>/dev/null
  exit 1
fi

# Runs as root. Ctrl+C stops Flask, then files root created are handed back to you.
sudo -A env PYTHONPATH="$USER_SITE" PYTHONDONTWRITEBYTECODE=1 \
  bash -c 'trap : INT; python3 app.py; chown -R "$0:$1" logs data' "$APP_UID" "$APP_GID"
