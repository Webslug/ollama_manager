#!/usr/bin/python3
"""Whitelisted root actions for Ollama Manager. Only invoked by the app when it runs as root (run.sh).

Allowed actions only:
  start | stop | restart
  set-env KEY VALUE   (KEY and VALUE must pass the whitelist below)
"""
import re
import subprocess
import sys

SERVICE = "ollama"
DROPIN = "/etc/systemd/system/ollama.service.d/zz-manager.conf"
RULES = {
    "OLLAMA_KEEP_ALIVE": re.compile(r"^(-1|\d{1,6}[smh]?)$"),
    "OLLAMA_FLASH_ATTENTION": re.compile(r"^[01]$"),
    "OLLAMA_KV_CACHE_TYPE": re.compile(r"^(f16|q8_0|q4_0)$"),
    "OLLAMA_NUM_PARALLEL": re.compile(r"^[1-9][0-9]?$"),
    "OLLAMA_MAX_LOADED_MODELS": re.compile(r"^[0-9]{1,2}$"),
    "OLLAMA_NUM_CTX": re.compile(r"^([1-9]\d{2,6})$"),  # 128-9,999,999 tokens
}


def systemctl(*args):
    subprocess.run(["/usr/bin/systemctl", *args], check=True)


def read_dropin():
    values = {}
    try:
        with open(DROPIN, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r'^Environment="([A-Z_]+)=([^"]*)"$', line.strip())
                if m and m.group(1) in RULES:
                    values[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    return values


def main(argv):
    if len(argv) == 2 and argv[1] in ("start", "stop", "restart"):
        systemctl(argv[1], SERVICE)
        return 0
    if len(argv) == 4 and argv[1] == "set-env":
        key, value = argv[2], argv[3]
        if key in RULES and RULES[key].match(value):
            values = read_dropin()
            values[key] = value
            body = "[Service]\n" + "".join(f'Environment="{k}={v}"\n' for k, v in sorted(values.items()))
            with open(DROPIN, "w", encoding="utf-8") as fh:
                fh.write(body)
            systemctl("daemon-reload")
            systemctl("restart", SERVICE)
            return 0
    print("usage: ollama-manager-helper start|stop|restart|set-env KEY VALUE", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
