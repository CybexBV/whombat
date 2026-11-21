#!/usr/bin/env python3
"""QEMU's QMP for the community install test (IN-430): what a person at the screen does, from this machine.

  qmp.py SOCKET screendump FILE.png     the screen as it is (PNG)
  qmp.py SOCKET keys ctrl-alt-f2        one chord (qcodes joined by '-')
  qmp.py SOCKET type 'text\\n'          type text on the US layout (\\n is Enter)
  qmp.py SOCKET quit                    stop QEMU
  qmp.py SOCKET cmd NAME                any QMP command without arguments (system_powerdown, system_reset, cont,
                                        query-status)

SOCKET may be relative (run from the workspace): a unix socket path can't be longer than 107 bytes.
Standard library only.
"""
import json
import os
import socket
import sys
import time

SHIFTED = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': 'minus', '+': 'equal', '{': 'bracket_left', '}': 'bracket_right', '|': 'backslash', ':': 'semicolon',
    '"': 'apostrophe', '<': 'comma', '>': 'dot', '?': 'slash', '~': 'grave_accent',
}
PLAIN = {
    ' ': 'spc', '\n': 'ret', '-': 'minus', '=': 'equal', '[': 'bracket_left', ']': 'bracket_right',
    '\\': 'backslash', ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'dot', '/': 'slash',
    '`': 'grave_accent', '\t': 'tab',
}


def qcodes(ch):
    if ch.isascii() and ch.isalpha():
        return (['shift'] if ch.isupper() else []) + [ch.lower()]
    if ch.isdigit():
        return [ch]
    if ch in PLAIN:
        return [PLAIN[ch]]
    if ch in SHIFTED:
        return ['shift', SHIFTED[ch]]
    raise ValueError(f'no key for {ch!r}')


class QMP:
    def __init__(self, path):
        d, base = os.path.split(path)
        if d:
            os.chdir(d)
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.s.connect(base)
        self.f = self.s.makefile('rw')
        json.loads(self.f.readline())  # greeting
        self.cmd('qmp_capabilities')

    def cmd(self, execute, **arguments):
        msg = {'execute': execute}
        if arguments:
            msg['arguments'] = arguments
        self.f.write(json.dumps(msg) + '\n')
        self.f.flush()
        while True:
            line = self.f.readline()
            if not line:
                return {}
            r = json.loads(line)
            if 'error' in r:
                raise RuntimeError(f'{execute}: {r["error"]}')
            if 'return' in r:
                return r['return']

    def chord(self, codes):
        self.cmd('send-key', keys=[{'type': 'qcode', 'data': c} for c in codes], **{'hold-time': 60})


def main():
    sock, op, *args = sys.argv[1:]
    target = os.path.abspath(args[0]) if op == 'screendump' else None  # before QMP() changes directory
    q = QMP(sock)
    if op == 'screendump':
        q.cmd('screendump', filename=target, format='png')
    elif op == 'keys':
        q.chord(args[0].split('-'))
    elif op == 'type':
        for ch in args[0].encode().decode('unicode_escape'):
            q.chord(qcodes(ch))
            time.sleep(0.03)
    elif op == 'quit':
        q.cmd('quit')
    elif op == 'cmd':
        print(json.dumps(q.cmd(args[0])))
    else:
        raise SystemExit(f'unknown op {op}')


if __name__ == '__main__':
    main()
