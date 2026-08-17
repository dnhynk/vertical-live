"""Start a codex reviewer terminal in the review worktree, wait for TUI idle, inject the review task, press Enter, confirm.
Usage: python start_reviewer.py <review_task_id> <pr_number>
Prints the terminal handle and dispatch id.
"""
import json, subprocess, sys, time, re
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
WT = "id:f5dd030a-828b-4bcc-b1b8-dc22b95053bf::C:/Users/dongh/orca/workspaces/vertical-live/review"
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
    # Fallback (2026-08-17: create --command timed out after runtime restart): plain shell, then type the codex command.
    print("terminal create --command failed:", json.dumps(d.get("error"), ensure_ascii=False)[:200], "-> two-step fallback")
    d2 = run(["terminal", "create", "--worktree", WT, "--title", f"review-pr-{pr}"])
    if not d2.get("ok"):
        print("terminal create (shell) failed", json.dumps(d2, ensure_ascii=False)[:600]); sys.exit(1)
    r = d2["result"]; handle = (r.get("terminal") or r).get("handle")
    time.sleep(3)
    run(["terminal", "send", "--terminal", handle, "--text", CMD, "--enter"])
    print("handle:", handle, "(shell + codex command)")
w = run(["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "120000"])
print("tui-idle:", json.dumps(w.get("result", {}).get("wait", {}), ensure_ascii=False)[:200])
time.sleep(5)
dsp = run(["orchestration", "dispatch", "--task", task_id, "--to", handle, "--inject"])
print("dispatch ok:", dsp.get("ok"), json.dumps(dsp.get("error"), ensure_ascii=False)[:300] if not dsp.get("ok") else "")
time.sleep(20)
t = tail(handle, 700)
if "Pasted Content" in t or "coordinator has more" in t[-600:]:
    run(["terminal", "send", "--terminal", handle, "--enter"])
    print("sent Enter")
    time.sleep(25)
    t = tail(handle, 700)
sys.stdout.buffer.write(("--- tail ---\n" + t + "\n").encode("utf-8", "replace"))
ds = run(["orchestration", "dispatch-show", "--task", task_id])
print("dispatch:", json.dumps({k: (ds.get("result", {}).get("dispatch") or {}).get(k) for k in ("id", "status", "assignee_handle")}, ensure_ascii=False))
