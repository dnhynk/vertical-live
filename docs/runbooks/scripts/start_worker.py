"""Start a claude worker in a new top-level worktree for a task, verify the prompt got submitted (send Enter if needed).
Usage: python start_worker.py <task_id> <slug>
"""
import json, subprocess, sys, time, re
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
REPO = "id:f5dd030a-828b-4bcc-b1b8-dc22b95053bf"
task_id, slug = sys.argv[1], sys.argv[2]

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

def tail(handle, n=1200):
    d = run(["terminal", "read", "--terminal", handle])
    t = d.get("result", {}).get("terminal", {})
    tl = t.get("tail")
    txt = "\n".join(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False) for x in tl) if isinstance(tl, list) else str(tl)
    txt = re.sub(r"[\u2500-\u259f]{3,}", "", txt); txt = re.sub(r"\n\s*\n+", "\n", txt)
    return txt[-n:]

d = run(["orchestration", "worker-start", "--task", task_id, "--worktree", "new-top-level", "--repo", REPO, "--name", slug, "--agent", "claude", "--setup", "run", "--timeout-ms", "180000"])
if not d.get("ok"):
    print("worker-start failed", json.dumps(d, ensure_ascii=False)[:800]); sys.exit(1)
r = d["result"]
handle = None
for e in r.get("effects", []):
    if e.get("kind") == "terminal" and e.get("role") == "agent":
        handle = e.get("id")
print("dispatchId:", r.get("dispatchId"), "| state:", r.get("state"), "| handle:", handle)
for e in r.get("effects", []):
    if e.get("kind") == "worktree":
        print("worktree:", e.get("id"))
# verify submission: wait until injected text fully landed & stable, then one Enter, then verify
def started(t):
    return bool(re.search(r"^● ", t, re.M)) or "esc to interrupt" in t or "⎿" in t or "Read " in t
submitted = False
prev = None
for attempt in range(12):
    time.sleep(15)
    t = tail(handle, 1500)
    if started(t):
        submitted = True; break
    end_marker = "PR 번호 포함" in t
    if end_marker and t == prev:
        run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "20000"])
        run(["terminal", "send", "--terminal", handle, "--enter"])
        print(f"attempt {attempt}: sent Enter (stable composer)")
        time.sleep(30)
        t2 = tail(handle, 1500)
        if started(t2):
            submitted = True; break
    prev = t
print("submitted:", submitted)
sys.stdout.buffer.write(("--- tail ---" + chr(10) + tail(handle, 600) + chr(10)).encode("utf-8", "replace"))
