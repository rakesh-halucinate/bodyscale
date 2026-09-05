#!/usr/bin/env python3
"""
BLE transport for the body scale reader.

Speaks newline-delimited JSON on stdout so the decoding side stays in
JavaScript, where it is already covered by tests. This process does nothing but
find the scale, connect, subscribe, and relay raw frames.

There is no device chooser here. That dialog is a browser security feature; a
local process addresses the scale by name or address directly, so the first run
learns the address and every run after that connects straight to it.

Events emitted, one JSON object per line:
    {"t":"log","level":"info|warn|error","msg":...}
    {"t":"device","name":...,"address":...,"rssi":...}
    {"t":"services","items":[{"service":...,"char":...,"props":[...]}]}
    {"t":"frame","uuid":...,"hex":"aa bb ..."}
    {"t":"ready"}      subscribed, waiting for the scale to send something
    {"t":"end","reason":...}
"""
import argparse
import asyncio
import errno
import json
import os
import platform
import sys
import threading

# bleak is imported defensively so --selftest can report a missing or broken
# install as structured JSON instead of dying with a traceback before it runs.
try:
    from bleak import BleakClient, BleakScanner
    BLEAK_IMPORT_ERROR = None
except Exception as _exc:                                          # noqa: BLE001
    BleakClient, BleakScanner = None, None
    BLEAK_IMPORT_ERROR = f"{type(_exc).__name__}: {_exc}"


def emit(**obj):
    """Write one protocol line, and leave quietly if nobody is listening.

    A closed pipe is the NORMAL end of a measurement, not a fault: the parent
    took its reading and killed this process, and the two events race. There is
    no one left to tell, so reporting it is impossible by definition — and
    trying anyway is what turned one closed pipe into three tracebacks on the
    user's terminal after a measurement that had already succeeded.

    os._exit is deliberate. A normal exit would run the interpreter's own final
    flush of stdout, which raises the same BrokenPipeError again on the way out
    and prints "Exception ignored in: <_io.TextIOWrapper name='<stdout>'>".
    Leaving immediately also releases the Bluetooth link sooner.
    """
    try:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except BrokenPipeError:
        os._exit(0)
    except ValueError:                    # "I/O operation on closed file"
        os._exit(0)
    except OSError as exc:
        if exc.errno in (errno.EPIPE, errno.EBADF):
            os._exit(0)
        raise


def log(msg, level="info"):
    emit(t="log", level=level, msg=msg)


async def find_device(name, address, scan_timeout):
    """Attach on the first matching advertisement.

    A single scan matches on address OR name and resolves the moment either
    hits, rather than trying the address first and only then falling back to a
    name scan. The scale advertises in short bursts when it wakes, so the gap
    between an advertisement arriving and the connect attempt has to be as close
    to zero as possible; a two-phase search can miss a whole burst.
    """
    want_addr = (address or "").strip().lower()
    want_name = (name or "").strip().lower()
    if not want_addr and not want_name:
        return None

    loop = asyncio.get_running_loop()
    found = loop.create_future()
    t0 = loop.time()

    def on_detect(dev, adv):
        if found.done():
            return
        if want_addr and (dev.address or "").lower() == want_addr:
            found.set_result((dev, adv, "address"))
            return
        seen = (dev.name or adv.local_name or "").strip().lower()
        if want_name and seen == want_name:
            found.set_result((dev, adv, "name"))

    log("scanning" + (f" for {name}" if name else "") + (f" / {address}" if address else ""))
    scanner = BleakScanner(detection_callback=on_detect)
    await scanner.start()
    try:
        dev, adv, how = await asyncio.wait_for(found, timeout=scan_timeout)
        ms = int((loop.time() - t0) * 1000)
        log(f"advertisement from {dev.name or name} after {ms} ms (matched by {how}, rssi {getattr(adv, 'rssi', '?')})")
        return dev
    except asyncio.TimeoutError:
        return None
    finally:
        # Stop before connecting: an active scan competes with the radio and
        # slows the connection down.
        try:
            await scanner.stop()
        except Exception:                                          # noqa: BLE001
            pass


async def run(args):
    dev = await find_device(args.name, args.address, args.scan_timeout)
    if dev is None:
        emit(t="end", reason="not-found")
        return 2

    emit(t="device", name=dev.name or args.name, address=dev.address)

    connect_started = asyncio.get_running_loop().time()
    disconnected = asyncio.Event()

    def on_disconnect(_client):
        disconnected.set()

    async with BleakClient(dev, disconnected_callback=on_disconnect,
                           timeout=args.connect_timeout) as client:
        ms = int((asyncio.get_running_loop().time() - connect_started) * 1000)
        log(f"connected in {ms} ms")
        items = []
        for service in client.services:
            for ch in service.characteristics:
                items.append({"service": service.uuid, "char": ch.uuid, "props": list(ch.properties)})
        emit(t="services", items=items)

        def frame(ch, data: bytearray):
            emit(t="frame", uuid=str(ch.uuid), hex=" ".join(f"{b:02x}" for b in data))

        async def subscribe_to(want):
            """Subscribe to named characteristics, or to everything if none named.

            Subscribing blindly to every notify characteristic is not harmless.
            This scale exposes a Nordic DFU characteristic (0x1531) alongside its
            own, and a client that turns on notifications for a firmware-update
            channel is not behaving like the phone app. The vendor app subscribes
            to the record channel first and adds the weight stream only once the
            scale has announced its session, so the order is a signal in itself.
            """
            n = 0
            for service in client.services:
                for ch in service.characteristics:
                    if "notify" not in ch.properties and "indicate" not in ch.properties:
                        continue
                    short = str(ch.uuid).lower()
                    if want and not any(w in short for w in want):
                        continue
                    try:
                        await client.start_notify(ch, frame)
                        log(f"subscribed to {ch.uuid}")
                        n += 1
                    except Exception as exc:                       # noqa: BLE001
                        log(f"could not subscribe to {ch.uuid}: {exc}", "warn")
            return n

        wanted = [w.strip().lower() for w in (args.chars or "").split(",") if w.strip()]
        subscribed = await subscribe_to(wanted)
        if not subscribed:
            log("nothing on this device can push data", "error")
            emit(t="end", reason="no-notifications")
            return 3

        log(f"subscribed to {subscribed} characteristic(s)")
        emit(t="ready")

        # Run until the parent closes stdin, the scale drops the link, or we time
        # out. Reading stdin is done on a worker thread rather than through
        # loop.connect_read_pipe, because that call is not supported on the
        # Windows proactor event loop and raises NotImplementedError there.
        # A DAEMON thread, not run_in_executor. asyncio.run() ends by calling
        # loop.shutdown_default_executor(), which joins its worker threads; a
        # worker parked on a read that will never return makes that join hang
        # forever, so the process never reaches its own exit. A daemon thread
        # is not joined at interpreter exit, so it cannot block shutdown.
        async def do_write(req):
            """Write one packet to a characteristic, on behalf of the decoder.

            The decoding lives in JavaScript, so the handshake a scale expects
            is composed there and sent here to be put on the wire. Without this
            the write side did not exist at all: a driver could compose a
            handshake and it went nowhere.
            """
            char = req.get("char")
            try:
                data = bytes.fromhex(str(req.get("hex", "")).replace(" ", ""))
            except ValueError:
                log(f"write to {char}: hex payload is malformed", "error")
                return
            if not char or not data:
                log(f"write to {char}: nothing to send", "error")
                return
            try:
                await client.write_gatt_char(char, data, response=bool(req.get("response", True)))
                emit(t="wrote", char=char, bytes=len(data), what=req.get("what"))
            except Exception as exc:                  # noqa: BLE001
                log(f"write to {char} failed: {type(exc).__name__}: {exc}", "error")

        async def wait_stdin_eof():
            """Serve commands from the parent until it closes the pipe.

            Reading stdin happens on a DAEMON thread, not run_in_executor.
            asyncio.run() ends by calling loop.shutdown_default_executor(),
            which joins its workers; a worker parked on a read that will never
            return makes that join hang forever. A daemon thread is not joined
            at interpreter exit, so it cannot block shutdown.

            The work itself is handed back to the event loop, because bleak is
            not thread-safe and a GATT write must run on the loop that owns the
            connection.
            """
            loop = asyncio.get_running_loop()
            done = asyncio.Event()

            def block():
                try:
                    for line in sys.stdin:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            req = json.loads(line)
                        except ValueError:
                            continue                  # not for us; ignore quietly
                        if isinstance(req, dict) and req.get("cmd") == "write":
                            loop.call_soon_threadsafe(
                                lambda r=req: asyncio.ensure_future(do_write(r)))
                        elif isinstance(req, dict) and req.get("cmd") == "subscribe":
                            loop.call_soon_threadsafe(
                                lambda r=req: asyncio.ensure_future(
                                    subscribe_to([str(r.get("char", "")).lower()])))
                except Exception:                     # noqa: BLE001  closed pipe
                    pass
                loop.call_soon_threadsafe(done.set)

            threading.Thread(target=block, name="stdin-commands", daemon=True).start()
            await done.wait()

        tasks = [asyncio.create_task(wait_stdin_eof()),
                 asyncio.create_task(disconnected.wait()),
                 asyncio.create_task(asyncio.sleep(args.hold))]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()

    emit(t="end", reason="disconnected" if disconnected.is_set() else "finished")
    return 0


# Refusal and absence look similar from here but need opposite advice, so they
# are kept apart. "Turn on the privacy toggle" is a dead end for someone whose
# Bluetooth radio is simply switched off, and vice versa.
_DENIED_MARKERS = (
    "access is denied", "accessdenied", "access denied",
    "unauthorized", "not permitted",
    "0x80070005",                           # E_ACCESSDENIED
    "permission",
)
_UNAVAILABLE_MARKERS = (
    "the device is not ready",              # adapter present but not started
    "element not found",                    # WinRT enumeration with the radio off
    "0x80070490",                           # ERROR_NOT_FOUND
    "bluetooth device is turned off", "bluetooth is not enabled",
    "no such device", "adapter not found", "bluetooth adapter",
    "no powered", "poweredoff", "bluetooth is powered off",
)


def bleak_version():
    try:
        import importlib.metadata as md
        return md.version("bleak")
    except Exception:                                              # noqa: BLE001
        try:
            import bleak
            return getattr(bleak, "__version__", "unknown")
        except Exception:                                          # noqa: BLE001
            return "unknown"


def classify_failure(exc):
    """Name the failure so the caller can tell the user something true.

    Windows refuses Bluetooth by raising, with no prompt and no signal, so the
    message text is the only evidence. macOS kills the process outright with
    SIGABRT, which the caller detects separately.
    """
    text = f"{type(exc).__name__}: {exc}".lower()
    if any(marker in text for marker in _DENIED_MARKERS):
        return "permission-denied"
    if any(marker in text for marker in _UNAVAILABLE_MARKERS):
        return "bluetooth-unavailable"
    return "error"


def main():
    ap = argparse.ArgumentParser(description="Relay BLE notifications from a body scale as JSON lines.")
    ap.add_argument("--name", default=None, help="device name to scan for, e.g. SSW533")
    ap.add_argument("--address", default=None, help="saved address, tried before the name")
    ap.add_argument("--scan-timeout", type=float, default=20.0)
    ap.add_argument("--connect-timeout", type=float, default=20.0)
    ap.add_argument("--hold", type=float, default=120.0, help="give up after this many seconds")
    ap.add_argument("--chars", default="",
                    help="comma-separated characteristic UUIDs to subscribe to at first; "
                         "empty means every notify characteristic, which is rarely what a "
                         "vendor app does")
    ap.add_argument("--selftest", action="store_true",
                    help="check that this interpreter can import bleak, then exit")
    args = ap.parse_args()

    if args.selftest:
        if BLEAK_IMPORT_ERROR:
            emit(t="selftest", ok=False, error=BLEAK_IMPORT_ERROR,
                 python=sys.version.split()[0], executable=sys.executable)
            sys.stdout.flush()
            return 1
        emit(t="selftest", ok=True, bleak=bleak_version(),
             python=sys.version.split()[0], executable=sys.executable,
             platform=platform.system())
        sys.stdout.flush()
        return 0

    if BLEAK_IMPORT_ERROR:
        log(f"bleak could not be imported: {BLEAK_IMPORT_ERROR}", "error")
        emit(t="end", reason="error", detail=BLEAK_IMPORT_ERROR)
        return 1
    log(f"platform {platform.system()} {platform.release()}, python {sys.version.split()[0]}")
    try:
        code = asyncio.run(run(args))
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except (BrokenPipeError, ValueError, OSError):
            os._exit(0)               # the parent is already gone
        # Every line is flushed as it is written, and both streams are flushed
        # again here, so nothing is lost. _exit skips any remaining atexit work
        # and the daemon reader, which may still be parked on a read.
        os._exit(code)
    except KeyboardInterrupt:
        emit(t="end", reason="interrupted")
        sys.exit(130)
    except (BrokenPipeError, ValueError):
        # The parent closed the pipe while we were mid-write. There is no
        # channel left to explain that on, so do not try; emit() would raise
        # again inside this very handler.
        os._exit(0)
    except Exception as exc:                                       # noqa: BLE001
        log(f"{type(exc).__name__}: {exc}", "error")
        reason = classify_failure(exc)
        if reason == "permission-denied":
            log("this looks like the operating system refusing Bluetooth, not a "
                "problem with the scale", "error")
        elif reason == "bluetooth-unavailable":
            log("this looks like Bluetooth being switched off or the adapter "
                "being unavailable, not a problem with the scale", "error")
        emit(t="end", reason=reason, detail=f"{type(exc).__name__}: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    # --selftest returns a status rather than exiting in place; every other
    # path exits on its own, and sys.exit(None) is a clean zero.
    sys.exit(main())
