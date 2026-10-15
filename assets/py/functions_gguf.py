"""Reads a .gguf header (never the weights) to spot files Ollama cannot load."""
import struct

# Tensor types known to mainline ggml / Ollama. Anything else (for example the
# custom PQ2_0 type 142) cannot be loaded and fails with "size overflow".
KNOWN_TYPES = set(range(0, 4)) | set(range(6, 31)) | {34, 35, 39}
TYPE_NAMES = {0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0",
              30: "BF16", 142: "PQ2_0"}
MAX_STRING = 1 << 20
MAX_COUNT = 1 << 24

_FIXED = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f",
          7: "<?", 10: "<Q", 11: "<q", 12: "<d"}


class _Reader:
    def __init__(self, handle):
        self.f = handle

    def take(self, n):
        data = self.f.read(n)
        if len(data) != n:
            raise ValueError("truncated header")
        return data

    def unpack(self, fmt):
        return struct.unpack(fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self):
        n = self.unpack("<Q")
        if n > MAX_STRING:
            raise ValueError("bad string length")
        return self.take(n).decode("utf8", "replace")

    def skip_value(self, kind):
        if kind == 8:
            self.string()
        elif kind == 9:
            inner, count = self.unpack("<I"), self.unpack("<Q")
            if count > MAX_COUNT:
                raise ValueError("bad array length")
            if inner in _FIXED:
                self.take(count * struct.calcsize(_FIXED[inner]))
            else:
                for _ in range(count):
                    self.skip_value(inner)
        elif kind in _FIXED:
            self.take(struct.calcsize(_FIXED[kind]))
        else:
            raise ValueError("unknown value type")


def inspect(path):
    """Return {"arch", "bad_types": {id: count}, "custom_keys": bool}, or None if unreadable."""
    try:
        with open(path, "rb") as handle:
            r = _Reader(handle)
            if r.take(4) != b"GGUF":
                return None
            r.unpack("<I")
            n_tensors, n_kv = r.unpack("<Q"), r.unpack("<Q")
            if n_tensors > MAX_COUNT or n_kv > MAX_COUNT:
                return None
            arch, custom = "", False
            for _ in range(n_kv):
                key, kind = r.string(), r.unpack("<I")
                if key == "general.architecture" and kind == 8:
                    arch = r.string()
                    continue
                if key.startswith("prism."):
                    custom = True
                r.skip_value(kind)
            bad = {}
            for _ in range(n_tensors):
                r.string()
                for _ in range(r.unpack("<I")):
                    r.unpack("<Q")
                kind = r.unpack("<I")
                r.unpack("<Q")
                if kind not in KNOWN_TYPES:
                    bad[kind] = bad.get(kind, 0) + 1
            return {"arch": arch, "bad_types": bad, "custom_keys": custom}
    except (OSError, ValueError, struct.error):
        return None


def unsupported_reason(path):
    """A plain-English reason Ollama cannot load this file, or None if it looks fine."""
    info = inspect(path)
    if not info or not info["bad_types"]:
        return None
    names = ", ".join(TYPE_NAMES.get(t, f"type {t}") for t in sorted(info["bad_types"]))
    extra = " It also needs custom transforms (prism.* metadata)." if info["custom_keys"] else ""
    return (f"This file uses a quantization Ollama cannot load ({names}).{extra} "
            "It needs a custom llama.cpp build, or pick a standard quant such as Q4_K_M or Q8_0.")
