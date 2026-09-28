#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram PC Remote — single-file Windows 11 remote control bot.

Everything is in this one file. No config.json, no log files, no downloads
folder. Just run it (or install autostart) and control the PC from Telegram.

Requirements (install once):
    pip install pyTelegramBotAPI psutil pillow

First run:
    python bot.py                # run now
    python bot.py --install      # start silently on every login
    python bot.py --uninstall    # remove autostart

To make it *fully silent* when running manually, rename this file to
`pcbot.pyw` and double-click it. Windows will launch it with pythonw.exe
and no console window will appear.
"""

from __future__ import annotations

import ctypes
import functools
import html
import io
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════
#   EDIT THESE TWO LINES ONLY
# ═══════════════════════════════════════════════════════════════════════════
BOT_TOKEN = "8761147219:AAFi0UGZ96NImrhDMf1b_RDCRg7bD_FwAiE"
OWNER_ID  = 8145533824
# ═══════════════════════════════════════════════════════════════════════════

APP_NAME  = "TelegramPCRemote"
RUN_KEY   = r"Software\Microsoft\Windows\CurrentVersion\Run"
LOCK_PORT = 47653          # single-instance guard
MAX_MSG   = 4000
TIMEOUT   = 120            # default command timeout (seconds)
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# ─── imports after token so we can fail fast ──────────────────────────────
try:
    import telebot
    from telebot import types
    import psutil
    from PIL import ImageGrab
except ImportError as exc:
    # If pythonw is running this and a dependency is missing, silently exit.
    print(f"Missing dependency: {exc}\nRun: pip install pyTelegramBotAPI psutil pillow",
          file=sys.stderr)
    sys.exit(1)

bot = telebot.TeleBot(BOT_TOKEN, parse_mode="HTML")


# ═══════════════════════════════════════════════════════════════════════════
#  HELPERS
# ═══════════════════════════════════════════════════════════════════════════
def _decode(data: bytes | None) -> str:
    if not data:
        return ""
    for enc in ("utf-8", "oem", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", "replace")


def send(chat_id: int, text: str):
    """Send possibly-long text, splitting on 4000 chars."""
    for i in range(0, max(len(text), 1), MAX_MSG):
        try:
            bot.send_message(chat_id, text[i:i + MAX_MSG] or " ", disable_web_page_preview=True)
        except Exception:
            pass


def reply(message, text: str):
    try:
        bot.reply_to(message, text[:MAX_MSG], disable_web_page_preview=True)
    except Exception:
        pass


def args(message) -> str:
    parts = (message.text or "").split(maxsplit=1)
    return parts[1].strip() if len(parts) > 1 else ""


def strip_fence(text: str) -> str:
    """Remove ``` fences from multi-line commands."""
    text = text.strip()
    if text.startswith("```") and text.endswith("```"):
        text = text[3:-3].strip()
        first, _, rest = text.partition("\n")
        if first.isalpha() and rest:
            text = rest
    return text


def run(cmd: str, shell: str = "cmd", timeout: int = TIMEOUT) -> tuple[int, str]:
    """Run a shell command. shell='cmd' or 'ps' (PowerShell)."""
    try:
        if shell == "ps":
            p = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-Command", cmd],
                capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        else:
            p = subprocess.run(cmd, shell=True, capture_output=True,
                               timeout=timeout, creationflags=NO_WINDOW)
        return p.returncode, _decode(p.stdout) + _decode(p.stderr)
    except subprocess.TimeoutExpired:
        return -1, f"timed out after {timeout}s"
    except Exception as exc:
        return -1, str(exc)


def local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close()
        return ip
    except OSError:
        return "unknown"


def uptime_str(sec: float) -> str:
    sec = int(sec); d, r = divmod(sec, 86400); h, r = divmod(r, 3600); m, s = divmod(r, 60)
    return " ".join(filter(None, [f"{d}d" if d else "", f"{h}h" if h else "",
                                  f"{m}m" if m else "", f"{s}s"]))


# ═══════════════════════════════════════════════════════════════════════════
#  AUTH
# ═══════════════════════════════════════════════════════════════════════════
def owner_only(fn):
    @functools.wraps(fn)
    def wrap(message, *a, **kw):
        if message.chat.id != OWNER_ID:
            try:
                bot.reply_to(message, f"⛔ Not authorised.\nYour chat id: <code>{message.chat.id}</code>")
            except Exception:
                pass
            return
        return fn(message, *a, **kw)
    return wrap


# ═══════════════════════════════════════════════════════════════════════════
#  COMMANDS
# ═══════════════════════════════════════════════════════════════════════════
HELP = """🤖 <b>PC Remote Bot</b>

<b>SYSTEM</b>
/help – this help
/ping – is the PC alive?
/sysinfo – CPU, RAM, disk, battery, uptime
/ip – local + public IP

<b>SCREEN</b>
/screenshot – capture all monitors
/msg &lt;text&gt; – popup on PC screen

<b>SHELL</b>
/cmd &lt;command&gt; – run in cmd.exe
/ps1 &lt;command&gt; – run in PowerShell
/ps – top 15 processes by RAM
/kill &lt;pid|name&gt; – kill a process

<b>POWER</b>
/lock – lock the screen
/sleep – suspend
/shutdown [sec] – shut down (default 0)
/restart [sec] – restart
/cancel – abort pending shutdown

<b>FILES</b>
/ls &lt;path&gt; – list a directory
/get &lt;path&gt; – download a file to Telegram
<i>(send any file to the bot to save it to your Downloads folder)</i>

<b>AUDIO</b>
/volume up | down | mute

<b>Tip:</b> wrap multi-line commands in triple backticks:
<code>```
ipconfig /all
dir C:\\
```</code>
"""


@bot.message_handler(commands=["start", "help"])
@owner_only
def cmd_help(message):
    reply(message, HELP)


@bot.message_handler(commands=["ping"])
@owner_only
def cmd_ping(message):
    reply(message, f"🏓 Pong — {datetime.now():%Y-%m-%d %H:%M:%S}")


@bot.message_handler(commands=["ip"])
@owner_only
def cmd_ip(message):
    try:
        import urllib.request
        with urllib.request.urlopen("https://api.ipify.org", timeout=6) as r:
            pub = r.read().decode().strip()
    except Exception:
        pub = "unknown"
    reply(message, f"🌐 <b>Network</b>\n"
                   f"Host: <code>{socket.gethostname()}</code>\n"
                   f"Local IP: <code>{local_ip()}</code>\n"
                   f"Public IP: <code>{pub}</code>")


@bot.message_handler(commands=["sysinfo", "info"])
@owner_only
def cmd_sysinfo(message):
    try:
        cpu = psutil.cpu_percent(interval=1)
        ram = psutil.virtual_memory()
        disk = psutil.disk_usage("C:\\")
        batt = psutil.sensors_battery()
        lines = [
            "🖥 <b>System</b>",
            f"Host: <code>{socket.gethostname()}</code>",
            f"OS: {sys.getwindowsversion().major}.{sys.getwindowsversion().minor}",
            f"CPU: {cpu:.0f}%  ({psutil.cpu_count()} threads)",
            f"RAM: {ram.used/2**30:.1f}/{ram.total/2**30:.1f} GB ({ram.percent:.0f}%)",
            f"Disk C: {disk.used/2**30:.1f}/{disk.total/2**30:.1f} GB ({disk.percent:.0f}%)",
            f"Uptime: {uptime_str(time.time() - psutil.boot_time())}",
        ]
        if batt:
            lines.append(f"Battery: {batt.percent:.0f}% "
                         f"({'charging' if batt.power_plugged else 'battery'})")
        reply(message, "\n".join(lines))
    except Exception as exc:
        reply(message, f"❌ {html.escape(str(exc))}")


@bot.message_handler(commands=["screenshot", "screen"])
@owner_only
def cmd_screenshot(message):
    try:
        bot.send_chat_action(message.chat.id, "upload_photo")
        img = ImageGrab.grab(all_screens=True)
        buf = io.BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
        buf.name = f"screen_{datetime.now():%Y%m%d_%H%M%S}.png"
        bot.send_photo(message.chat.id, buf,
                       caption=f"🖥 {datetime.now():%H:%M:%S}")
    except Exception as exc:
        reply(message, f"❌ {html.escape(str(exc))}")


@bot.message_handler(commands=["cmd", "shell", "exec"])
@owner_only
def cmd_cmd(message):
    _shell(message, "cmd")


@bot.message_handler(commands=["ps1", "powershell", "pwsh"])
@owner_only
def cmd_ps1(message):
    _shell(message, "ps")


def _shell(message, shell: str):
    raw = strip_fence(args(message))
    if not raw:
        name = "/cmd" if shell == "cmd" else "/ps1"
        reply(message, f"Usage: <code>{name} &lt;command&gt;</code>")
        return
    bot.send_chat_action(message.chat.id, "typing")
    code, out = run(raw, shell=shell)
    out = out.rstrip() or "(no output)"
    label = "cmd" if shell == "cmd" else "powershell"
    header = (f"<b>$</b> <code>{html.escape(raw)}</code>\n"
              f"<b>{label}</b> · exit {code}\n")
    first = True
    while True:
        piece, out = out[:3500], out[3500:]
        text = header + f"<pre>{html.escape(piece)}</pre>" if first else f"<pre>{html.escape(piece)}</pre>"
        try:
            bot.send_message(message.chat.id, text, disable_web_page_preview=True)
        except Exception:
            break
        first = False
        if not out:
            break


@bot.message_handler(commands=["ps", "processes"])
@owner_only
def cmd_ps(message):
    rows = []
    for p in psutil.process_iter(["pid", "name", "memory_info"]):
        try:
            rss = p.info["memory_info"].rss if p.info["memory_info"] else 0
            rows.append((rss, p.info["pid"], p.info["name"] or "?"))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    rows.sort(reverse=True)
    txt = "<b>Top processes by RAM</b>\n" + "\n".join(
        f"{i:>2}. {html.escape(n)} — {m/2**20:.0f} MB (pid {p})"
        for i, (m, p, n) in enumerate(rows[:15], 1))
    reply(message, txt)


@bot.message_handler(commands=["kill"])
@owner_only
def cmd_kill(message):
    t = args(message)
    if not t:
        reply(message, "Usage: <code>/kill &lt;pid|name&gt;</code>")
        return
    killed, failed = [], []
    if t.isdigit():
        try:
            p = psutil.Process(int(t)); n = p.name(); p.terminate()
            killed.append(f"{n} ({t})")
        except Exception as exc:
            failed.append(str(exc))
    else:
        for p in psutil.process_iter(["pid", "name"]):
            try:
                if (p.info["name"] or "").lower() == t.lower():
                    p.terminate(); killed.append(f"{p.info['name']} ({p.info['pid']})")
            except Exception as exc:
                failed.append(str(exc))
    msg = ("✅ Killed: " + ", ".join(killed)) if killed else ""
    if failed:
        msg += "\n❌ " + "\n".join(failed[:3])
    reply(message, msg or "Nothing matched.")


# ─── power ────────────────────────────────────────────────────────────────
@bot.message_handler(commands=["lock"])
@owner_only
def cmd_lock(message):
    ctypes.windll.user32.LockWorkStation()
    reply(message, "🔒 Locked")


@bot.message_handler(commands=["sleep", "suspend"])
@owner_only
def cmd_sleep(message):
    reply(message, "😴 Suspending…")
    subprocess.Popen("rundll32.exe powrprof.dll,SetSuspendState 0,1,0",
                     shell=True, creationflags=NO_WINDOW)


@bot.message_handler(commands=["shutdown"])
@owner_only
def cmd_shutdown(message):
    a = args(message); sec = int(a) if a.isdigit() else 0
    reply(message, f"⏻ Shutting down in {sec}s…")
    subprocess.Popen(f'shutdown /s /t {sec} /c "From Telegram"', shell=True)


@bot.message_handler(commands=["restart", "reboot"])
@owner_only
def cmd_restart(message):
    a = args(message); sec = int(a) if a.isdigit() else 0
    reply(message, f"🔄 Restarting in {sec}s…")
    subprocess.Popen(f'shutdown /r /t {sec} /c "From Telegram"', shell=True)


@bot.message_handler(commands=["cancel", "abort"])
@owner_only
def cmd_cancel(message):
    code, out = run("shutdown /a")
    reply(message, "✅ Shutdown aborted." if code == 0 else f"⚠️ {html.escape(out.strip())}")


# ─── screen popup ────────────────────────────────────────────────────────
@bot.message_handler(commands=["msg", "notify"])
@owner_only
def cmd_msg(message):
    text = args(message) or "Hello from Telegram!"
    threading.Thread(
        target=lambda: ctypes.windll.user32.MessageBoxW(0, text, "Telegram", 0x40),
        daemon=True).start()
    reply(message, "💬 Popup shown")


# ─── volume ──────────────────────────────────────────────────────────────
VK_UP, VK_DOWN, VK_MUTE = 0xAF, 0xAE, 0xAD


def _key(vk: int, times: int = 1):
    for _ in range(times):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        ctypes.windll.user32.keybd_event(vk, 0, 2, 0)
        time.sleep(0.03)


@bot.message_handler(commands=["volume", "vol"])
@owner_only
def cmd_volume(message):
    a = args(message).lower()
    if a.startswith("up"):
        _key(VK_UP, 5); reply(message, "🔊 Volume up")
    elif a.startswith("down"):
        _key(VK_DOWN, 5); reply(message, "🔉 Volume down")
    elif a.startswith("mute"):
        _key(VK_MUTE); reply(message, "🔇 Mute toggled")
    else:
        reply(message, "Usage: <code>/volume up|down|mute</code>")


# ─── files ───────────────────────────────────────────────────────────────
@bot.message_handler(commands=["ls", "dir"])
@owner_only
def cmd_ls(message):
    path = args(message) or os.path.expanduser("~")
    try:
        entries = sorted(os.listdir(path))
    except Exception as exc:
        reply(message, f"❌ {html.escape(str(exc))}")
        return
    lines = [f"📁 <code>{html.escape(path)}</code>"]
    for name in entries[:80]:
        full = os.path.join(path, name)
        if os.path.isdir(full):
            lines.append(f"📁 {html.escape(name)}")
        else:
            try:
                size = os.path.getsize(full)
                lines.append(f"📄 {html.escape(name)} — {size:,} B")
            except OSError:
                lines.append(f"📄 {html.escape(name)}")
    if len(entries) > 80:
        lines.append(f"… and {len(entries)-80} more")
    send(message.chat.id, "\n".join(lines))


@bot.message_handler(commands=["get", "download"])
@owner_only
def cmd_get(message):
    path = args(message).strip('"')
    if not path or not os.path.isfile(path):
        reply(message, "❌ Provide a valid file path.")
        return
    if os.path.getsize(path) > 49 * 1024 * 1024:
        reply(message, "❌ File > 50 MB (Telegram bot limit).")
        return
    try:
        bot.send_chat_action(message.chat.id, "upload_document")
        with open(path, "rb") as fh:
            bot.send_document(message.chat.id, fh, caption=os.path.basename(path))
    except Exception as exc:
        reply(message, f"❌ {html.escape(str(exc))}")


@bot.message_handler(content_types=["document"])
@owner_only
def on_doc(message):
    try:
        info = bot.get_file(message.document.file_id)
        data = bot.download_file(info.file_path)
        name = os.path.basename(message.document.file_name or f"file_{int(time.time())}")
        # Save to user's Downloads folder
        dest_dir = os.path.join(os.path.expanduser("~"), "Downloads")
        os.makedirs(dest_dir, exist_ok=True)
        dest = os.path.join(dest_dir, name)
        with open(dest, "wb") as fh:
            fh.write(data)
        reply(message, f"💾 Saved to <code>{html.escape(dest)}</code>")
    except Exception as exc:
        reply(message, f"❌ {html.escape(str(exc))}")


@bot.message_handler(func=lambda m: True, content_types=["text"])
def fallback(message):
    if message.chat.id != OWNER_ID:
        try: bot.reply_to(message, f"⛔ Not authorised.\nYour chat id: <code>{message.chat.id}</code>")
        except Exception: pass
        return
    reply(message, "Unknown command. Try /help")


# ═══════════════════════════════════════════════════════════════════════════
#  AUTOSTART (HKCU\...\Run)
# ═══════════════════════════════════════════════════════════════════════════
def _autostart_cmd() -> str:
    pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.isfile(pythonw):
        pythonw = sys.executable
    return f'"{pythonw}" "{os.path.abspath(__file__)}"'


def install_autostart():
    import winreg
    key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)
    winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, _autostart_cmd())
    winreg.CloseKey(key)
    print("✅ Autostart installed — the bot will run silently on next login.")


def uninstall_autostart():
    import winreg
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)
        winreg.DeleteValue(key, APP_NAME); winreg.CloseKey(key)
        print("✅ Autostart removed.")
    except FileNotFoundError:
        print("ℹ️ Nothing to remove.")


# ═══════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════
def main():
    if "--install"   in sys.argv: return install_autostart()
    if "--uninstall" in sys.argv: return uninstall_autostart()

    # Single-instance guard
    global _sock
    try:
        _sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        _sock.bind(("127.0.0.1", LOCK_PORT)); _sock.listen(1)
    except OSError:
        return  # already running

    # Tell the owner we're online
    try:
        bot.send_message(
            OWNER_ID,
            f"🟢 <b>PC online</b>\n"
            f"<code>{socket.gethostname()}</code> · <code>{local_ip()}</code>\n"
            f"{datetime.now():%Y-%m-%d %H:%M:%S}\n\n"
            f"Send /help for commands.")
    except Exception:
        pass

    # Register command menu
    try:
        bot.set_my_commands([
            types.BotCommand("screenshot", "Capture screen"),
            types.BotCommand("cmd",        "Run cmd.exe command"),
            types.BotCommand("ps1",        "Run PowerShell command"),
            types.BotCommand("sysinfo",    "System stats"),
            types.BotCommand("ps",         "Top processes"),
            types.BotCommand("lock",       "Lock PC"),
            types.BotCommand("shutdown",   "Shut down"),
            types.BotCommand("restart",    "Restart"),
            types.BotCommand("get",        "Download file"),
            types.BotCommand("help",       "Show help"),
        ])
    except Exception:
        pass

    while True:
        try:
            bot.infinity_polling(timeout=30, long_polling_timeout=30)
        except Exception:
            time.sleep(10)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Silent fail — no crash dumps on screen
        sys.exit(1)
