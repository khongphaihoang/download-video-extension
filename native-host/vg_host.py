#!/usr/bin/env python3
"""
Video Grabber — Native Messaging host.

Nhận lệnh từ extension (Chrome Native Messaging: 4 byte độ dài little-endian + JSON UTF-8),
gọi yt-dlp + ffmpeg để tải và ghép video YouTube độ phân giải cao (480p -> 4K).

Lệnh hỗ trợ:
  {"action": "ping"}
      -> {"type": "pong", "ytdlp": "<version|null>", "ffmpeg": true|false, "host": "1.0.0"}
  {"action": "download", "url": "...", "height": 1080|null, "outDir": "..."(tùy chọn)}
      -> nhiều {"type": "progress", "percent": 42.1, "speed": "...", "eta": "..."}
      -> kết thúc {"type": "done", "ok": true, "file": "..."} hoặc {"type": "done", "ok": false, "error": "..."}
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys

HOST_VERSION = "1.0.0"
YT_URL_RE = re.compile(r"^https?://([a-z0-9-]+\.)?(youtube\.com|youtu\.be)/", re.I)
PROGRESS_RE = re.compile(r"^VGPROG\|([^|]*)\|([^|]*)\|([^|]*)$")


# --------------------------------------------------------------- stdio protocol
def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def refresh_windows_path():
    """Nạp lại PATH từ registry (trình duyệt đang mở có thể giữ PATH cũ trước khi cài yt-dlp/ffmpeg)."""
    if os.name != "nt":
        return
    try:
        import winreg

        parts = []
        for hive, sub in (
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
            (winreg.HKEY_CURRENT_USER, "Environment"),
        ):
            try:
                with winreg.OpenKey(hive, sub) as key:
                    value, _ = winreg.QueryValueEx(key, "Path")
                    parts.append(os.path.expandvars(value))
            except OSError:
                pass
        parts.append(os.environ.get("PATH", ""))
        seen, merged = set(), []
        for chunk in os.pathsep.join(parts).split(os.pathsep):
            c = chunk.strip()
            if c and c.lower() not in seen:
                seen.add(c.lower())
                merged.append(c)
        os.environ["PATH"] = os.pathsep.join(merged)
    except Exception:
        pass


# ------------------------------------------------------------------ tool lookup
def find_ytdlp_cmd():
    """Trả về list lệnh chạy yt-dlp, hoặc None nếu chưa cài."""
    exe = shutil.which("yt-dlp") or shutil.which("yt-dlp.exe")
    if exe:
        return [exe]
    # Fallback: module Python (pip install yt-dlp)
    try:
        probe = subprocess.run(
            [sys.executable, "-m", "yt_dlp", "--version"],
            capture_output=True, text=True, timeout=15,
            creationflags=_no_window(),
        )
        if probe.returncode == 0:
            return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        pass
    return None


def _no_window():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ytdlp_version(cmd):
    try:
        out = subprocess.run(
            cmd + ["--version"], capture_output=True, text=True, timeout=15,
            creationflags=_no_window(),
        )
        return out.stdout.strip() or None
    except Exception:
        return None


def default_out_dir():
    return os.path.join(os.path.expanduser("~"), "Downloads")


# --------------------------------------------------------------------- actions
def handle_ping():
    cmd = find_ytdlp_cmd()
    send_message({
        "type": "pong",
        "host": HOST_VERSION,
        "ytdlp": ytdlp_version(cmd) if cmd else None,
        "ffmpeg": bool(shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")),
    })


def build_format(height):
    if not height:
        return "bv*+ba/b"
    h = int(height)
    return f"bv*[height<={h}]+ba/b[height<={h}]/b"


def handle_download(msg):
    url = str(msg.get("url") or "")
    if not YT_URL_RE.match(url):
        send_message({"type": "done", "ok": False, "error": "URL không phải YouTube"})
        return

    cmd = find_ytdlp_cmd()
    if not cmd:
        send_message({
            "type": "done", "ok": False, "code": "NO_YTDLP",
            "error": "Chưa cài yt-dlp (chạy: winget install yt-dlp.yt-dlp)",
        })
        return
    if not (shutil.which("ffmpeg") or shutil.which("ffmpeg.exe")):
        send_message({
            "type": "done", "ok": False, "code": "NO_FFMPEG",
            "error": "Chưa cài ffmpeg để ghép hình+tiếng (chạy: winget install Gyan.FFmpeg)",
        })
        return

    out_dir = str(msg.get("outDir") or default_out_dir())
    os.makedirs(out_dir, exist_ok=True)
    template = os.path.join(out_dir, "%(title).150B [%(height)sp].%(ext)s")

    args = cmd + [
        "--no-playlist",
        "--no-warnings",
        "-f", build_format(msg.get("height")),
        "--merge-output-format", "mp4",
        "--newline",
        "--progress",
        "--progress-template",
        "download:VGPROG|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--no-simulate",
        "--print", "after_move:filepath",
        "-o", template,
        url,
    ]

    final_file = None
    last_err = ""
    try:
        proc = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            creationflags=_no_window(),
        )
    except Exception as exc:  # noqa: BLE001
        send_message({"type": "done", "ok": False, "error": f"Không chạy được yt-dlp: {exc}"})
        return

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        m = PROGRESS_RE.match(line)
        if m:
            pct = re.sub(r"[^0-9.]", "", m.group(1))
            send_message({
                "type": "progress",
                "percent": float(pct) if pct else None,
                "speed": m.group(2).strip(),
                "eta": m.group(3).strip(),
            })
        elif os.path.isabs(line):
            final_file = line

    err_text = proc.stderr.read() or ""
    proc.wait()
    for ln in err_text.splitlines():
        if ln.strip():
            last_err = ln.strip()

    if proc.returncode == 0 and final_file:
        send_message({"type": "done", "ok": True, "file": final_file})
    else:
        send_message({
            "type": "done", "ok": False,
            "error": last_err or f"yt-dlp thoát với mã {proc.returncode}",
        })


def main():
    refresh_windows_path()
    msg = read_message()
    if msg is None:
        return
    action = msg.get("action")
    if action == "ping":
        handle_ping()
    elif action == "download":
        handle_download(msg)
    else:
        send_message({"type": "done", "ok": False, "error": f"Lệnh không hỗ trợ: {action}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        try:
            send_message({"type": "done", "ok": False, "error": f"Lỗi host: {exc}"})
        except Exception:
            pass
