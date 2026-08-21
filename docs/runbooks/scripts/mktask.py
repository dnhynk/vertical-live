"""Create an Orca task from a spec file safely (no shell interpolation).
Usage: python mktask.py <spec_file> [--deps task_id,task_id]
Prints: task id
"""
import json, subprocess, sys
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
spec = open(sys.argv[1], encoding="utf-8").read().strip()
args = [ORCA, "orchestration", "task-create", "--spec", spec, "--json"]
if len(sys.argv) > 3 and sys.argv[2] == "--deps":
    args += ["--deps", json.dumps(sys.argv[3].split(","))]
r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
try:
    d = json.loads(r.stdout)
    t = d["result"].get("task", d["result"])
    print(t["id"], t.get("status"))
except Exception:
    print("FAILED", r.stdout[:400], r.stderr[:400]); sys.exit(1)
