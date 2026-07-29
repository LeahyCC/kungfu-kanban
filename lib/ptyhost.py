#!/usr/bin/env python3
"""One pty session for the board's built-in terminal.

Spawned by lib/pty.js. NOTE the name: this file must never be called pty.py —
python puts the script's own directory first on sys.path, so it would shadow
the stdlib `pty` module it imports two lines down.

The shell gets a REAL controlling tty (not a pipe), so
~/.zshrc, starship, colors, job control, and full-screen TUIs behave exactly
as they do in Ghostty.

Wiring (fds are set up by the node parent):
    stdin  (0) — keystrokes from the browser, forwarded raw to the pty
    stdout (1) — pty output, forwarded raw to the browser
    stderr (2) — our own diagnostics only
    fd 3       — control channel, one JSON object per line: {"resize":[cols,rows]}

Python's stdlib pty/fcntl are used instead of node-pty on purpose: node-pty is
a native module that needs a C++ toolchain at install time, and this app's whole
promise is `git pull && npm i`. The stdlib gives us the same ioctl (TIOCSWINSZ)
that makes resize work.

argv: pty.py <cwd> <cols> <rows> <shell> [shell-args...]
"""

import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl

BUF = 65536


def set_winsize(fd, cols, rows):
    # TIOCSWINSZ takes rows first; a 0 in either axis makes curses apps unusable
    cols = max(1, min(2000, int(cols)))
    rows = max(1, min(1000, int(rows)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main():
    cwd, cols, rows, shell = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    shell_args = sys.argv[5:]

    try:
        os.chdir(cwd)
    except OSError:
        os.chdir(os.path.expanduser("~"))

    pid, fd = pty.fork()
    if pid == 0:
        # child: stdin/stdout/stderr are the slave tty, and it is our
        # controlling terminal — everything an interactive shell expects.
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "kungfu-kanban"
        # A shell that thinks it is inside the board's agent runner would load
        # the wrong context; this is a human's terminal.
        env.pop("CLAUDECODE", None)
        env.pop("CLAUDE_CODE_ENTRYPOINT", None)
        try:
            os.execvpe(shell, [shell] + shell_args, env)
        except OSError as e:
            os.write(2, f"failed to exec {shell}: {e}\n".encode())
            os._exit(127)

    set_winsize(fd, cols, rows)
    # The parent must not die on a broken pipe to the browser side; we detect
    # EOF/EPIPE from read/write and shut down deliberately instead.
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    ctrl = b""
    watch = [fd, 0, 3]
    while True:
        try:
            readable, _, _ = select.select(watch, [], [])
        except (InterruptedError, OSError):
            break

        if 0 in readable:  # keystrokes → pty
            try:
                data = os.read(0, BUF)
            except OSError:
                data = b""
            if not data:
                break  # node closed our stdin: the session is being torn down
            try:
                os.write(fd, data)
            except OSError:
                break

        if 3 in readable:  # control frames → ioctl
            try:
                chunk = os.read(3, BUF)
            except OSError:
                chunk = b""
            if not chunk:
                # EOF on the control pipe: stop selecting on it, or select()
                # would report it ready forever and spin the CPU.
                watch.remove(3)
            else:
                ctrl += chunk
                while b"\n" in ctrl:
                    line, ctrl = ctrl.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        msg = json.loads(line)
                        if "resize" in msg:
                            set_winsize(fd, msg["resize"][0], msg["resize"][1])
                            os.kill(pid, signal.SIGWINCH)
                    except (ValueError, KeyError, IndexError, OSError, TypeError):
                        pass  # a malformed frame must never kill the session

        if fd in readable:  # pty output → browser
            try:
                data = os.read(fd, BUF)
            except OSError:
                data = b""  # EIO on macOS == the child exited
            if not data:
                break
            try:
                os.write(1, data)
            except OSError:
                break

    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
        sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
    except OSError:
        sys.exit(0)


if __name__ == "__main__":
    main()
