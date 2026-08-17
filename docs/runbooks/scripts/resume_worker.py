"""Re-dispatch a task into an EXISTING worktree (crash recovery), append a resume note to the injected prompt, submit, verify.
Usage: python resume_worker.py <task_id> <slug> <note_file>
"""
import json, subprocess, sys, time, re
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
REPO_ID = "f5dd030a-828b-4bcc-b1b8-dc22b95053bf"
task_id, slug, note_file = sys.argv[1], sys.argv[2], sys.argv[3]
note = open(note_file, encoding="utf-8").read().strip()
WT = f"id:{REPO_ID}::C:/Users/dongh/orca/workspaces/vertical-live/{slug}"

def run(args, timeout=240):
    r = subprocess.run([ORCA] + args + ["--json"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    dec = json.JSONDecoder(); s = r.stdout or ""; pos = 0; objs = []
    while True:
        i = s.find("{", pos)
        if i < 0: break
        try:
            o, e = dec.raw_decode(s, i); objs.append(o); pos = e
        except json.JSONDecodeError:
            pos = i + 1
    return objs[-1] if objs else {"ok": False, "raw": s[:500], "stderr": r.stderr[:500]}

def tail(handle, n=1500):
    d = run(["terminal", "read", "--terminal", handle])
    t = d.get("result", {}).get("terminal", {})
    tl = t.get("tail")
    txt = "\n".join(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False) for x in tl) if isinstance(tl, list) else str(tl)
    txt = re.sub(r"[\u2500-\u259f]{3,}", "", txt); txt = re.sub(r"\n\s*\n+", "\n", txt)
    return txt[-n:]

def started(t):
    return bool(re.search(r"^● ", t, re.M)) or "esc to interrupt" in t or "⎿" in t

d = run(["orchestration", "worker-start", "--task", task_id, "--worktree", WT, "--agent", "claude", "--timeout-ms", "180000"])
if not d.get("ok"):
    print("worker-start failed", json.dumps(d, ensure_ascii=False)[:800]); sys.exit(1)
r = d["result"]
handle = None
for e in r.get("effects", []):
    if e.get("kind") == "terminal" and e.get("role") == "agent":
        handle = e.get("id")
print("dispatchId:", r.get("dispatchId"), "| state:", r.get("state"), "| handle:", handle)

# wait for injected text to land and stabilize
prev = None; stable = False; auto = False
for attempt in range(12):
    time.sleep(15)
    t = tail(handle)
    if started(t):
        auto = True; break
    if "PR 번호 포함" in t and t == prev:
        stable = True; break
    prev = t
if auto:
    # already submitted: send the note as a follow-up message
    run(["terminal", "send", "--terminal", handle, "--text", note, "--enter"])
    print("auto-submitted; resume note sent as follow-up")
elif stable:
    run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "20000"])
    run(["terminal", "send", "--terminal", handle, "--text", "\n\n" + note])
    time.sleep(8)
    run(["terminal", "send", "--terminal", handle, "--enter"])
    print("appended resume note to composer and pressed Enter")
else:
    print("WARN: composer never stabilized; sending note + Enter anyway")
    run(["terminal", "send", "--terminal", handle, "--text", "\n\n" + note])
    time.sleep(8)
    run(["terminal", "send", "--terminal", handle, "--enter"])
time.sleep(35)
t = tail(handle, 900)
print("started:", started(t))
sys.stdout.buffer.write(("--- tail ---" + chr(10) + t + chr(10)).encode("utf-8", "replace"))
