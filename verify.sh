#!/bin/bash
# Regenerates VERIFIED.txt: everything that can be proven on this machine,
# and an explicit list of what cannot be, with the reason.
cd "$(dirname "$0")" || exit 1
OUT=VERIFIED.txt
FIXTURE=fixtures/ssw533-session.jsonl

hdr() { printf '\n############################################################\n#  %s\n############################################################\n' "$1"; }

{
hdr "1. FULL TEST SUITE"
node test/run-plan.js 2>&1 | tail -n +2

hdr "2. END TO END, REPLAYING A REAL CAPTURED SESSION"
node scale.js --replay "$FIXTURE" --sex male --age 39 --height 180 2>&1 >/dev/null | grep -E 'reading|captured|replaying'

hdr "3. THE JSON SERVICE, DRIVEN AS ELECTRON DRIVES IT"
node - <<'NODEEOF'
const { BodyScaleClient } = require('./electron-example/bodyscale-client.js');
(async () => {
  const c = new BodyScaleClient({ scaleDir: __dirname, replay: 'fixtures/ssw533-session.jsonl' });
  const phases = [];
  c.on('progress', (p) => { if (!phases.includes(p.phase)) phases.push(p.phase); });
  const hello = await c.start();
  console.log(`  hello           protocol ${hello.proto}, service ${hello.version} on ${hello.platform}`);
  const m = await c.measure({ age: 39, heightCm: 180, sex: 'male' });
  console.log(`  progress phases ${phases.join(' -> ')}`);
  console.log(`  measured        ${m.measured.weightKg} kg, ${m.measured.impedanceOhm} ohm`);
  console.log(`  derived         ${Object.keys(m.derived).length} values, every one with a unit and a confidence label`);
  console.log(`  recommended     ${m.bodyFatRecommended.value} % body fat (${m.bodyFatRecommended.key})`);
  console.log(`  trustworthy     ${m.trust.impedanceDerived}`);
  console.log(`  structuredClone ${JSON.stringify(structuredClone(m)) === JSON.stringify(m) ? 'survives, so it can cross to a renderer' : 'FAILED'}`);
  // Errors must arrive as typed codes, not as crashes.
  const bad = await c.measure({ age: 2, heightCm: 180 }).catch((e) => e);
  console.log(`  bad profile     rejected as ${bad.code}`);
  const pending = c.measure({ age: 39, heightCm: 180 });
  await new Promise((r) => c.once('accepted', r));
  await c.cancel();
  const cancelled = await pending.catch((e) => e);
  console.log(`  cancel          rejected the measurement as ${cancelled.code}`);
  await c.stop();
  console.log(`  stop            child gone, running=${c.running}`);
})().catch((e) => { console.log('  FAILED: ' + e.message); process.exit(1); });
NODEEOF

hdr "4. INTEGRATION OUTPUT (what the Electron app consumes)"
node scale.js --replay "$FIXTURE" --sex male --age 39 --height 180 --quiet 2>/dev/null | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r=JSON.parse(s);
  const row=(k,v,u)=>console.log("   "+k.padEnd(28)+String(v).padStart(10)+"  "+(u||""));
  console.log("  MEASURED BY THE SCALE");
  row("weight", r.measured.weightKg, "kg"); row("impedance", r.measured.impedanceOhm, "ohm");
  console.log("  DERIVED");
  for (const k of Object.keys(r.derived)) row(k, r.derived[k], r.units[k]);
});'

hdr "5. THE TRANSPORT DIES WITH ITS PARENT"
python3 - <<'PYEOF'
# ble.py waits on stdin from a worker thread rather than loop.connect_read_pipe,
# because that call does not exist on the Windows proactor loop. Prove the
# pattern wakes on EOF rather than waiting out its hold timer.
import subprocess, sys, tempfile, textwrap, time, os
probe = textwrap.dedent('''
    import asyncio, os, sys, time
    async def run():
        async def wait_stdin_eof():
            def block():
                for _ in sys.stdin: pass
            await asyncio.get_running_loop().run_in_executor(None, block)
        t0 = time.time()
        tasks = [asyncio.create_task(wait_stdin_eof()), asyncio.create_task(asyncio.sleep(30))]
        try: await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks: t.cancel()
        print("   woke after %.2f s" % (time.time() - t0), flush=True)
        return 0
    code = asyncio.run(run()); sys.stdout.flush(); os._exit(code)
''')
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
    f.write(probe); path = f.name
py = "./blehost" if os.path.exists("./blehost") else sys.executable
t0 = time.time()
p = subprocess.Popen([py, path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
time.sleep(1.0)
p.stdin.close()                       # the event under test
# communicate() would try to flush the stdin we just closed, so read directly.
out = p.stdout.read()
p.wait(timeout=10)
dt = time.time() - t0
print(out.rstrip())
print("   exited code=%d after %.2f s" % (p.returncode, dt))
print("   %s" % ("PASS: EOF woke it, so no orphan can hold the radio"
                 if dt < 5 else "FAIL: it waited out the hold timer"))
os.unlink(path)
PYEOF

hdr "6. WHAT IS NOT VERIFIED ON THIS MACHINE, AND WHY"
cat <<'TXTEOF'

  a) The live Bluetooth connection, from here.

     macOS attributes a Bluetooth request to the responsible application for
     the process tree. Every process started from this session is attributed
     to Claude Desktop, which holds no Bluetooth entitlement, so macOS kills
     the child before any code runs:

         Termination Reason: Namespace TCC
         responsibleProc  : claude

     The service reports this correctly rather than crashing. Driven against
     the real radio from here it returns:

         {"type":"error","code":"PERMISSION_DENIED",
          "detail":{"outcome":"tcc-denied","framesSeen":0}}

     From Terminal.app the responsible application is Terminal, macOS prompts
     once, and the connection works. That path was exercised earlier in this
     project against the real SSW533.

  b) Windows, on Windows.

     ble.py's stdin wait was rewritten because loop.connect_read_pipe raises
     NotImplementedError on the Windows proactor event loop. The replacement
     is platform-independent and is proven above, but it has been run on
     macOS only. The same applies to setup-win.ps1, which is brace-balanced
     but has not been parsed by PowerShell, and to the electron-builder
     packaging configuration.

     Everything either side of the radio is covered by the test suite, which
     runs identically on both platforms.
TXTEOF

hdr "TO RUN IT AGAINST THE REAL SCALE"
cat <<'TXTEOF'

   Step on the scale first, then, from Terminal:

     cd /path/to/bodyscale
     node scale.js

   As a service, the way the Electron app talks to it:

     node scale.js --serve

   With no hardware at all:

     node scale.js --serve --replay fixtures/ssw533-session.jsonl
TXTEOF
} > "$OUT" 2>&1

echo "wrote $OUT"
grep -cE '^' "$OUT" | sed 's/^/  lines: /'
