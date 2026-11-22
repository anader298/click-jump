#!/usr/bin/env python3
"""Runs `click-jump --terminal` in a real pseudo-terminal and checks Vim follows clicks."""
import json, os, pty, re, select, shutil, signal, subprocess, sys, tempfile, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin", "click-jump.js")
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(f"{'pass' if ok else 'FAIL'}  {name}{'  ' + str(detail) if detail and not ok else ''}", flush=True)

class Session:
    def __init__(self, cwd, args):
        self.out = b""
        env = {k: v for k, v in os.environ.items() if not k.startswith("VIM")}
        # Isolated: no user vimrc, no real browser.
        env.update(HOME=cwd, CLICK_JUMP_NO_OPEN="1", TERM="xterm-256color", LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe("node", ["node", BIN, "--terminal", "--no-open", *args], env)
        import fcntl, struct, termios
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    def pump(self, secs=0.1):
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], max(0, end - time.time()))
            if r:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    return

    def wait_for(self, pattern, secs=10):
        end = time.time() + secs
        while time.time() < end:
            m = re.search(pattern, self.out)
            if m:
                return m
            self.pump(0.05)
        raise RuntimeError(f"timeout waiting for {pattern!r}; got {self.out[-400:]!r}")

    def send(self, text):
        os.write(self.fd, text.encode())

    def query(self, cwd, expr):
        """Asks Vim for a value by having it write to a file."""
        out = os.path.join(cwd, "vim-answer.txt")
        if os.path.exists(out):
            os.unlink(out)
        self.send(f"\x1b:call writefile([{expr}], 'vim-answer.txt')\r")
        end = time.time() + 4
        while time.time() < end:
            self.pump(0.03)
            if os.path.exists(out):
                self.pump(0.03)
                return open(out, encoding="utf-8").read().strip()
        raise RuntimeError(f"no answer for {expr}")

    def close(self):
        try:
            self.send("\x1b:qa!\r")
        except OSError:
            pass
        end = time.time() + 5
        while time.time() < end:
            self.pump(0.05)
            done, status = os.waitpid(self.pid, os.WNOHANG)
            if done:
                return os.waitstatus_to_exitcode(status)
        os.kill(self.pid, signal.SIGKILL)
        os.waitpid(self.pid, 0)
        return None

def jump(url, token, loc):
    origin = re.match(r"http://[^/]+", url).group(0)
    req = urllib.request.Request(origin + "/__cj/open", method="POST", data=json.dumps({"loc": loc}).encode(),
        headers={"Origin": origin, "X-CJ-Token": token, "Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=4).status

def wait_value(s, cwd, expr, want, secs=4):
    end = time.time() + secs
    got = None
    while time.time() < end:
        got = s.query(cwd, expr)
        if got == want:
            return got
        time.sleep(0.05)
    return got

def main():
    cwd = os.path.realpath(tempfile.mkdtemp(prefix="cj-vim-"))
    second = "we ird 'name' \"q\" café.html"
    with open(os.path.join(cwd, "index.html"), "w", encoding="utf-8") as f:
        f.write("<!doctype html>\n<body>\n<h1>one</h1>\n<p>café \U0001F370 <b>two</b></p>\n" + "".join(f"<div>{i}</div>\n" for i in range(80)) + "<footer>end</footer>\n</body>\n")
    with open(os.path.join(cwd, second), "w", encoding="utf-8") as f:
        f.write("<p>first</p>\n<p>second</p>\n")
    src = open(os.path.join(cwd, "index.html"), "rb").read()
    s = Session(cwd, [])
    try:
        url = s.wait_for(rb"Preview: (http://\S+)").group(1).decode()
        s.pump(0.8)
        page = urllib.request.urlopen(url, timeout=4).read().decode()
        token = re.search(r'data-cj-token="([^"]+)"', page).group(1)
        check("Vim opened index.html", s.query(cwd, "expand('%:t')") == "index.html")

        check("jump accepted", jump(url, token, "index.html:3:1") == 204)
        check("cursor on line 3", wait_value(s, cwd, "line('.')", "3") == "3")
        check("flash match present", wait_value(s, cwd, "len(getmatches())", "1") == "1")
        check("flash group is ClickJumpFlash", "ClickJumpFlash" in s.query(cwd, "string(getmatches())"))
        check("flash clears by itself", wait_value(s, cwd, "len(getmatches())", "0", 3) == "0")

        loc = re.search(r'<b data-cj="([^"]+)"', page).group(1)
        jump(url, token, loc)
        check("column right after emoji", wait_value(s, cwd, "line('.').':'.charcol('.')", "4:11") == "4:11",
              s.query(cwd, "line('.').':'.charcol('.')"))

        footer = re.search(r'<footer data-cj="([^"]+)"', page).group(1)
        jump(url, token, footer)
        check("scrolls to a far line", wait_value(s, cwd, "line('.')", "85") == "85")
        check("far line is on screen", int(s.query(cwd, "line('w0')")) <= 85 <= int(s.query(cwd, "line('w$')")))

        from urllib.parse import quote
        s.send("\x1b:call setline(1, getline(1))\r")   # leave an unsaved change
        s.pump(0.2)
        jump(url, token, quote(second, safe="") + ":2:1")
        check("follows into a second file with a hostile name",
              wait_value(s, cwd, "expand('%:t')", second) == second, s.query(cwd, "expand('%:t')"))
        check("line in second file", wait_value(s, cwd, "line('.')", "2") == "2")
        check("unsaved buffer kept, not lost", s.query(cwd, "getbufvar('index.html', '&modified')") == "1")

        s.send("\x1b:b index.html\r")
        s.pump(0.2)
        s.send("\x1b:e!\r")
        s.pump(0.2)
        s.send(":")  # stay in command-line mode
        s.pump(0.1)
        jump(url, token, "index.html:3:1")
        s.pump(0.5)
        s.send("\x1b")
        s.pump(0.1)
        check("a click does not break a half-typed command", s.query(cwd, "mode()") == "n")

        check("source unchanged", open(os.path.join(cwd, "index.html"), "rb").read() == src)
    finally:
        code = s.close()
    check("exits cleanly with :qa", code == 0, code)
    try:
        urllib.request.urlopen(url, timeout=1)
        check("server stopped after Vim quit", False)
    except Exception:
        check("server stopped after Vim quit", True)
    shutil.rmtree(cwd, ignore_errors=True)
    failed = results.count(False)
    print(f"\nvim: {len(results)} checks, {len(results) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)

main()
