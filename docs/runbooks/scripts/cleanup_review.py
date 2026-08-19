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
def close_panes():
    """`terminal stop` kills the agent but leaves idle panes titled review/review2; close those ptys too."""
    r = subprocess.run([ORCA, "terminal", "list", "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        ts = json.loads(r.stdout).get("result", {}).get("terminals", [])
    except Exception:
        return 0
    n = 0
    for t in ts:
        h = t.get("handle") or t.get("id"); title = (t.get("title") or "").strip()
        if title == name:
            rr = subprocess.run([ORCA, "terminal", "close", "--terminal", h, "--json"], capture_output=True, text=True, encoding="utf-8", errors="replace")
            try:
                n += 1 if json.loads(rr.stdout).get("ok") else 0
            except Exception:
                pass
    return n
print("panes closed:", close_panes())
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
