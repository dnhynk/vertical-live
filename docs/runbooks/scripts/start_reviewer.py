"""Start a codex reviewer terminal in the review worktree, wait for TUI idle, inject the review task, press Enter, confirm.
Usage: python start_reviewer.py <review_task_id> <pr_number>
Prints the terminal handle and dispatch id.
"""
import json, subprocess, sys, time, re
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
REPO_ID = "f5dd030a-828b-4bcc-b1b8-dc22b95053bf"
WT_NAME = sys.argv[3] if len(sys.argv) > 3 else "review"
WT = f"id:{REPO_ID}::C:/Users/dongh/orca/workspaces/vertical-live/{WT_NAME}"
CMD = 'codex -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" -c service_tier="fast" --dangerously-bypass-approvals-and-sandbox'
task_id, pr = sys.argv[1], sys.argv[2]

def run(args):
    r = subprocess.run([ORCA] + args + ["--json"], capture_output=True, text=True, encoding="utf-8", errors="replace")
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

d = run(["terminal", "create", "--worktree", WT, "--title", f"review-pr-{pr}", "--command", CMD])
if d.get("ok"):
    r = d["result"]; handle = (r.get("terminal") or r).get("handle")
    print("handle:", handle, "(agent-first)")
else:
    # Fallback A (2026-08-17): agent-first often "times out waiting for terminal handle" but the codex terminal
    # actually exists. Find a fresh, undispatched codex terminal in the review worktree and reuse it.
    print("terminal create --command failed:", json.dumps(d.get("error"), ensure_ascii=False)[:200], "-> looking for the created terminal")
    handle = None
    time.sleep(5)
    lst = run(["terminal", "list"])
    cands = [t for t in lst.get("result", {}).get("terminals", []) if f"vertical-live/{WT_NAME}" in (t.get("worktreePath") or "")]
    for t in cands:
        pv = t.get("preview") or ""
        if ("OpenAI Codex" in pv or "YOLO" in pv or "gpt-5.6-sol" in pv) and "dispatched worker" not in pv and "worker_done" not in pv and "Ran" not in pv:
            handle = t["handle"]
    if handle:
        print("handle:", handle, "(reused freshly created codex terminal)")
    else:
        # Fallback B: plain shell, then type the codex command. NOTE: injection into a shell-launched codex has been
        # observed to type slowly and lossily (dropped characters) — prefer A.
        d2 = run(["terminal", "create", "--worktree", WT, "--title", f"review-pr-{pr}"])
        if not d2.get("ok"):
            print("terminal create (shell) failed", json.dumps(d2, ensure_ascii=False)[:600]); sys.exit(1)
        r = d2["result"]; handle = (r.get("terminal") or r).get("handle")
        time.sleep(3)
        run(["terminal", "send", "--terminal", handle, "--text", CMD, "--enter"])
        print("handle:", handle, "(shell + codex command; slow-typing risk)")
w = run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "120000"])
print("tui-idle:", json.dumps(w.get("result", {}).get("wait", {}), ensure_ascii=False)[:200])
time.sleep(5)
dsp = run(["orchestration", "dispatch", "--task", task_id, "--to", handle, "--inject"])
print("dispatch ok:", dsp.get("ok"), json.dumps(dsp.get("error"), ensure_ascii=False)[:300] if not dsp.get("ok") else "")
# Wait until the injected text has fully landed (stable for 3 polls), then press Enter once; verify start.
prev = None; stable = 0; started = False
for i in range(60):
    time.sleep(10)
    t = tail(handle, 1500)
    if "• Ran" in t or "esc to interrupt" in t:
        started = True; break
    stable = stable + 1 if t == prev else 0
    if stable >= 3 and ("Pasted Content" in t or "수정하지 않는다" in t or "worker_done" in t):
        run(["terminal", "send", "--terminal", handle, "--enter"])
        print(f"sent Enter (poll {i})")
        time.sleep(40)
        t = tail(handle, 1500)
        if "• Ran" in t or "esc to interrupt" in t:
            started = True; break
        stable = 0
    prev = t
print("started:", started)
sys.stdout.buffer.write(("--- tail ---\n" + t + "\n").encode("utf-8", "replace"))
ds = run(["orchestration", "dispatch-show", "--task", task_id])
print("dispatch:", json.dumps({k: (ds.get("result", {}).get("dispatch") or {}).get(k) for k in ("id", "status", "assignee_handle")}, ensure_ascii=False))
