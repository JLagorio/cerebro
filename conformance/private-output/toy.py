#!/usr/bin/env python3
"""M96 fixed synthetic fixture. Root-qualified interpreter only: -I -S -B.

Never discover credentials/configuration, create subprocesses, or use a network.
Claims are hints: only the separately qualified outer owner may arm this child.
"""
import json
import os
import signal
import stat
import sys
import time

LIMIT = 16_384
DOCUMENT_LIMIT = 8192
STARTUP_SECONDS = 3.0
SCENARIOS = {"exact-cap-stderr-env", "overflow-live", "eof-live", "live"}
CASE_SCENARIOS = {
    "N01": "exact-cap-stderr-env",
    "N02": "overflow-live",
    "N03": "eof-live",
    "N04": "live",
    "N05": "live",
    "N06": "live",
}
FORBIDDEN = {
    "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST", "GH_DEBUG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "PATH", "PYTHONPATH", "PYTHONHOME",
}


def fail():
    # Finite fixture refusal; no exception, path, environment, or output text.
    os._exit(74)


def pin(value):
    return len(value) == 64 and all(char in "0123456789abcdefABCDEF" for char in value)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            fail()
        view = view[count:]


def publish(root, name, document):
    encoded = json.dumps(document, separators=(",", ":"), sort_keys=True).encode("ascii")
    if len(encoded) > DOCUMENT_LIMIT:
        fail()
    fd = os.open(os.path.join(root, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        write_all(fd, encoded)
    finally:
        os.close(fd)


def read_document(root, name):
    try:
        fd = os.open(os.path.join(root, name), os.O_RDONLY | os.O_NOFOLLOW)
        try:
            metadata = os.fstat(fd)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > DOCUMENT_LIMIT:
                return None
            raw = b""
            while len(raw) <= DOCUMENT_LIMIT:
                chunk = os.read(fd, DOCUMENT_LIMIT + 1 - len(raw))
                if not chunk:
                    break
                raw += chunk
            if len(raw) > DOCUMENT_LIMIT:
                return None
            document = json.loads(raw)
            return document if isinstance(document, dict) else None
        finally:
            os.close(fd)
    except (OSError, ValueError, UnicodeError):
        return None


def main():
    if len(sys.argv) != 4:
        fail()
    scenario, root, nonce = sys.argv[1:]
    if scenario not in SCENARIOS or not os.path.isabs(root) or not pin(nonce):
        fail()
    metadata = os.lstat(root)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o077 or os.path.realpath(root) != root:
        fail()
    case = os.environ.get("M96_PRIVATE_TOY_CASE", "")
    intent = os.environ.get("M96_PRIVATE_TOY_INTENT_SHA256", "")
    owner = os.environ.get("M96_PRIVATE_TOY_OWNER_SHA256", "")
    if CASE_SCENARIOS.get(case) != scenario or not pin(intent) or not pin(owner):
        fail()

    # Fallback exits fail every cleanup acceptance. They cannot impersonate KILL.
    signal.signal(signal.SIGALRM, lambda _signal, _frame: os._exit(90))
    signal.alarm(25)
    if scenario != "exact-cap-stderr-env":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    pid, pgid = os.getpid(), os.getpgrp()
    if pid <= 1 or pgid != pid:
        fail()
    binding = {
        "format": 1, "case": case, "scenario": scenario, "nonce": nonce,
        "pid": pid, "pgid": pgid, "intent_sha256": intent, "owner_sha256": owner,
    }
    publish(root, "toy-claim.json", binding)
    started = time.monotonic()
    while True:
        arm = read_document(root, "arm.json")
        if arm is not None and all(arm.get(key) == value for key, value in binding.items()):
            start_identity = arm.get("root_bound_start")
            if arm.get("armed") is True and isinstance(start_identity, str) and 0 < len(start_identity) <= 128:
                break
        if time.monotonic() - started >= STARTUP_SECONDS:
            fail()
        time.sleep(0.005)

    expected_environment = {
        "HOME": os.path.join(root, "home"), "GH_CONFIG_DIR": os.path.join(root, "config"),
        "LANG": "C", "LC_ALL": "C", "M96_SYNTHETIC": "private-output-v1",
        # Qualified macOS interpreter adds this exact runtime-owned value.
        "__CF_USER_TEXT_ENCODING": f"0x{os.getuid():X}:0x0:0x0",
        "M96_PRIVATE_TOY_CASE": case, "M96_PRIVATE_TOY_INTENT_SHA256": intent,
        "M96_PRIVATE_TOY_OWNER_SHA256": owner,
    }
    null_device = os.stat("/dev/null")
    stdin = os.fstat(0)
    stderr = os.fstat(2)
    stdout = os.fstat(1)
    stdin_null = stat.S_ISCHR(stdin.st_mode) and stdin.st_rdev == null_device.st_rdev
    stderr_null = stat.S_ISCHR(stderr.st_mode) and stderr.st_rdev == null_device.st_rdev
    checks = {
        "stdin_null": stdin_null, "stderr_null": stderr_null,
        "stdout_pipe": stat.S_ISFIFO(stdout.st_mode),
        # Do not risk reading a caller pipe/terminal if nulling failed.
        "stdin_eof": stdin_null and os.read(0, 1) == b"",
        "environment_exact": dict(os.environ) == expected_environment,
        "forbidden_absent": FORBIDDEN.isdisjoint(os.environ),
    }
    publish(root, "ready.json", dict(binding, ready=True, **checks))
    if not all(checks.values()):
        fail()

    if scenario == "exact-cap-stderr-env":
        sentinel = b"CEREBRO_PRIVATE_STDERR_SENTINEL\n"
        remaining = 1_048_576
        block = sentinel * 256
        while remaining:
            chunk = block[:remaining]
            write_all(2, chunk)
            remaining -= len(chunk)
        write_all(1, b"Q" * LIMIT)
        os._exit(0)
    if scenario == "overflow-live":
        write_all(1, b"Q" * (LIMIT + 1))
    elif scenario == "eof-live":
        os.close(1)
    while True:
        signal.pause()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        fail()
