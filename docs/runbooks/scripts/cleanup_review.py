"""Stop reviewer terminals for a review worktree and drop its review/pr-N branch (worktree left detached on origin/main).
Usage: python cleanup_review.py <review|review2>
"""
import json, subprocess, sys
ORCA = r"C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe"
name = sys.argv[1]
wt = f"C:/Users/dongh/orca/workspaces/vertical-live/{name}"
r = subprocess.run([ORCA, "terminal", "stop", "--worktree", f"path:{wt}", "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace")
try:
    d = json.loads(r.stdout); print("terminals stopped:", (d.get("result") or {}).get("stopped"))
except Exception:
    print("terminal stop raw:", r.stdout[:200])
def git(*a):
    return subprocess.run(["git", "-C", wt] + list(a), capture_output=True, text=True, encoding="utf-8", errors="replace")
cur = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
git("fetch", "-q", "origin")
git("reset", "-q", "--hard")
git("clean", "-qfd")
git("checkout", "-q", "--detach", "origin/main")
if cur and cur != "HEAD" and cur.startswith(("review/pr-", "review2/pr-")):
    subprocess.run(["git", "-C", "C:/Users/dongh/vertical-live", "branch", "-D", cur], capture_output=True)
    print("deleted branch", cur)
print("worktree now:", git("rev-parse", "--short", "HEAD").stdout.strip(), "(detached origin/main)")
