import io, re
for f, pat in [(r"frontend\src\__tests__\clone-modal.test.ts", r"cm-chip|outputs|DONE"),
               (r"frontend\src\components\CloneModal.svelte", r"outputChips")]:
    src = io.open(f, encoding="utf-8").read().splitlines()
    print("=====", f)
    for i, l in enumerate(src):
        if re.search(pat, l):
            print(i+1, l.strip()[:170])
