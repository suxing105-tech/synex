# -*- coding: utf-8 -*-
"""真机跑一遍另外两种出声方式：音色描述、指定音色。都不吃参考音频。"""
import json, sys, time, urllib.request

BASE = "http://127.0.0.1:8897"


def call(path, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=600)
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode("utf-8")[:400])
        raise
    with r:
        raw = r.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def run(key, prompt, extra, controls):
    tpl = next(t for t in call("/api/clone/templates")["items"] if t["name"] == key)
    print("==== ", key, "id", tpl["id"], "modes", tpl.get("modes"),
          "slots", [(s["kind"], s["node"] + "." + s["input"], s["label"]) for s in tpl["slots"]])
    body = {"template_id": tpl["id"], "prompt": prompt, "references": [],
            "controls": controls, "source_image_id": None}
    body.update(extra)
    job = call("/api/clone/generate", "POST", body)
    print("SUBMIT", job.get("state"), job.get("message"))
    deadline = time.time() + 1200
    state = {}
    while time.time() < deadline:
        time.sleep(3)
        state = call("/api/clone/jobs/current")
        if not state.get("running") or state.get("state") in ("done", "error", "cancelled"):
            break
    print("STATE", state.get("state"), state.get("message"), state.get("error"))
    assert state.get("state") == "done", state
    out = state["outputs"][0]
    print("OUTPUT", json.dumps(out, ensure_ascii=False))
    assert out["kind"] == "audio", out
    detail = call("/api/images/" + str(out["id"]))
    print("DETAIL", detail.get("filename"), detail.get("duration_seconds"),
          "prompt=[" + (detail.get("positive_prompt") or "") + "]")
    return out


which = sys.argv[1]
if which == "design":
    out = run("闪寻音色描述",
              "真机实测：这一句是用文字描述出来的声音念的。",
              {"slot_prompts": {"38.instruct": "中年男性，低沉沙哑，语速很慢，像在讲一个秘密"}},
              {"38.language": "Chinese"})
else:
    out = run("闪寻指定音色",
              "真机实测：这一句用的是选定的人物音色。",
              {"slot_prompts": {"37.instruct": "轻松一点，带笑意"}},
              {"37.speaker": "Uncle_Fu", "37.language": "Chinese"})
print("OK", out["id"], out["filename"])

