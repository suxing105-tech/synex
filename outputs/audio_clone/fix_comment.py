# -*- coding: utf-8 -*-
import io
p = "backend/app/clone_jobs.py"
t = io.open(p, encoding="utf-8").read()
bad = '\u5386\u53f2\u91cc\u7528\u7684\u662f\n# {"audio": [...]}uff08\u771f\u673a\u5b9e\u6d4b\uff09'
good = '\u5386\u53f2\u91cc\u7528\u7684\u662f\n# {"audio": [...]}uff08\u771f\u673a\u5b9e\u6d4b\uff09'.replace("uff08", "\uff08")
assert t.count(bad) == 1
io.open(p, "w", encoding="utf-8", newline="\n").write(t.replace(bad, good, 1))
print("fixed comment")
