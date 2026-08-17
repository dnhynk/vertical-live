"""Coordinator helper: run `orca orchestration check --wait ...`, parse robustly, print summary.
Usage: python chk.py [timeout_ms] [--ack <deliveryId>] [--peek]
Saves raw output to chk_raw.txt and parsed messages to chk_last.json.
"""
import json, subprocess, sys, os
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
timeout = "540000"
extra = []
i = 0
while i < len(args):
    a = args[i]
    if a == "--ack":
        extra += ["--ack", args[i+1]]; i += 2; continue
    if a == "--peek":
        extra += ["--peek"]; i += 1; continue
    timeout = a; i += 1
cmd = [ORCA, "orchestration", "check"] + extra
if "--peek" not in extra:
    cmd += ["--wait", "--types", "worker_done,escalation,question", "--timeout-ms", timeout]
cmd += ["--json"]
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
raw = (r.stdout or "") + ("\n[stderr]\n" + r.stderr if r.stderr else "")
open(os.path.join(HERE, "chk_raw.txt"), "w", encoding="utf-8").write(raw)
# robust parse: find all top-level JSON objects in stdout
dec = json.JSONDecoder()
objs = []
s = r.stdout or ""
pos = 0
while True:
    idx = s.find("{", pos)
    if idx < 0: break
    try:
        obj, end = dec.raw_decode(s, idx)
        objs.append(obj); pos = end
    except json.JSONDecodeError:
        pos = idx + 1
if not objs:
    print("NO JSON PARSED. rc=", r.returncode); print(raw[:2000]); sys.exit(1)
d = objs[-1]
res = d.get("result", {})
print("ok", d.get("ok"), "| count", res.get("count"), "| deliveryId", res.get("deliveryId"), "| timedOut", res.get("timedOut"), "| ack", res.get("acknowledged"))
if not d.get("ok"):
    print(json.dumps(d.get("error"), ensure_ascii=False)[:1500])
msgs = res.get("messages") or []
json.dump(msgs, open(os.path.join(HERE, "chk_last.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for m in msgs:
    p = m.get("payload") or {}
    if isinstance(p, str):
        try: p = json.loads(p)
        except Exception: p = {"raw": p}
    print("=== msg", m.get("id"), "|", m.get("type"), "|", m.get("subject"))
    print("   from:", m.get("from") or m.get("sender"), "| task:", m.get("taskId") or p.get("taskId"), "| dispatch:", m.get("dispatchId") or p.get("dispatchId"), "| outcome:", p.get("outcome") or m.get("outcome"))
    body = m.get("body") or ""
    print(body[:2500])
    if p:
        keys = {k: v for k, v in p.items() if k not in ("body",)}
        print("   payload:", json.dumps(keys, ensure_ascii=False)[:600])
