# The pointer on the box's own screen (CG-410), read from QEMU's screen. cage starts with its pointer in the middle of
# the screen (on the Link code's dash) and this VM's tablet leaves it there: at rest nothing shows there, while the mouse
# moves the page's arrow does, and a few seconds later it is gone again. The screenshots are kept for people to see.
# (Its own names for the modules: the test scripts that include this import some of them too.)
import os as pointer_os
import tempfile as pointer_tempfile
import time as pointer_time


def screen_dump(m, name):
    path = pointer_os.path.join(pointer_tempfile.gettempdir(), f"{m.name}-{name}.ppm")
    m.send_monitor_command(f"screendump {path}")
    with open(path, "rb") as f:
        data = f.read()
    pointer_os.unlink(path)
    # QEMU writes "P6\n<width> <height>\n255\n" and then the pixels, three bytes each.
    magic, size, _, pixels = data.split(b"\n", 3)
    assert magic == b"P6", magic
    w, h = (int(v) for v in size.split())
    return w, h, pixels


def screen_changed(a, b, box):
    w = a[0]
    x0, y0, x1, y1 = box
    n = 0
    for y in range(y0, y1):
        ra = a[2][(y * w + x0) * 3 : (y * w + x1) * 3]
        rb = b[2][(y * w + x0) * 3 : (y * w + x1) * 3]
        if ra != rb:
            n += sum(1 for i in range(0, len(ra), 3) if ra[i : i + 3] != rb[i : i + 3])
    return n


def pointer_to(m, x, y, w, h):
    # An absolute position through QMP, as a VM's tablet or a noVNC mouse gives it: 0 … 0x7fff across the screen.
    # (HMP's mouse_move sends relative steps, which this VM's PS/2 mouse drops.)
    assert m.qmp_client is not None
    events: dict = {
        "events": [
            {"type": "abs", "data": {"axis": "x", "value": x * 0x7FFF // (w - 1)}},
            {"type": "abs", "data": {"axis": "y", "value": y * 0x7FFF // (h - 1)}},
        ]
    }
    m.qmp_client.send("input-send-event", events)


def pointer_check(m, label, steps=((30, 20), (60, 40), (90, 60))):
    rest = screen_dump(m, "rest")
    m.screenshot(f"{label}-pointer-rest")
    w, h, _ = rest
    # Around the middle, where cage put the pointer, and where the steps take it: a mouse moved right and down.
    box = (max(w // 2 - 160, 0), max(h // 2 - 80, 0), min(w // 2 + 200, w), min(h // 2 + 160, h))
    for dx, dy in steps:
        pointer_to(m, w // 2 + dx, h // 2 + dy, w, h)
        pointer_time.sleep(0.2)
    pointer_time.sleep(0.5)
    moved = screen_dump(m, "moved")
    m.screenshot(f"{label}-pointer-moved")
    pointer_time.sleep(6)
    hidden = screen_dump(m, "hidden")
    m.screenshot(f"{label}-pointer-hidden")
    shown, back = screen_changed(rest, moved, box), screen_changed(rest, hidden, box)
    print(f"{label}: {shown} pixels changed while the mouse moved, {back} a few seconds later (in {box} of {w}x{h})")
    assert shown >= 40, f"{label}: no pointer while the mouse moved"
    assert back <= 4, f"{label}: a pointer at rest (before the moves or after them)"
