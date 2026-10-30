# -*- coding: utf-8 -*-
"""真机跑一遍音频一键同款：两段文字分开喂，产出进库，来源能被下一次弹窗读回。"""
import io, json, time, urllib.request

BASE = "http://127.0.0.1:8897"
BUNDLE = r"backend/app/bundled_workflows/qwen3-tts-voice-clone.json"


def call(path, method="GET", body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req, timeout=600)
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode('utf-8')[:400])
        raise
    with r:
        raw = r.read().decode("utf-8")
    return json.loads(raw) if raw else {}


entry = json.load(io.open(BUNDLE, encoding="utf-8"))
templates = call("/api/clone/templates")["items"]
audio = next(t for t in templates if t.get("media_kind") == "audio")
print("BEFORE", audio["id"], audio["name"], [(s["input"], s.get("value")) for s in audio["slots"] if s["kind"] == "prompt"])
# 库里那条还是上一版装的（没有 value）：按安装包这版重刷槽位，等价于新用户第一次装载
call("/api/clone/templates/" + str(audio["id"]), "PATCH", {"slots": entry["slots"]})
fresh = next(t for t in call("/api/clone/templates")["items"] if t["id"] == audio["id"])
prompts = {s["input"]: s for s in fresh["slots"] if s["kind"] == "prompt"}
print("AFTER ", [(k, v["label"], v.get("value")) for k, v in prompts.items()])
assert prompts["ref_text"].get("value"), "槽位没带上原话"

audios = call("/api/items?kinds=audio&limit=8").get("items", [])
print("audio refs:", [(a["id"], a["filename"]) for a in audios])
assert audios, "库里没有音频可当参考音色"
ref = audios[0]

job = call("/api/clone/generate", "POST", {
    "template_id": audio["id"],
    "prompt": "这是新的一句台词，两段文字分开喂进去。",
    "references": [{"slot": "44.audio", "image_id": ref["id"]}],
    "controls": {"45.language": "Auto"},
    "slot_prompts": {"45.ref_text": "参考音频里的原话单独一格，不被台词冲掉。"},
    "source_image_id": ref["id"],
})
print("SUBMIT", job["state"], job["message"])
deadline = time.time() + 900
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
sources = call("/api/clone/sources/" + str(out["id"]))
print("SOURCES", json.dumps(sources, ensure_ascii=False)[:600])
assert sources["references"] and sources["references"][0]["kind"] == "audio", sources
# 音频带不走提示词：台词与原话只能靠生成当时记下的那两份，重开弹窗才不用重新打字
assert sources.get("prompt") == "这是新的一句台词，两段文字分开喂进去。", sources.get("prompt")
assert sources.get("slot_prompts") == {"45.ref_text": "参考音频里的原话单独一格，不被台词冲掉。"}, sources.get("slot_prompts")
detail = call("/api/images/" + str(out["id"]))
print("DETAIL prompt=[%s]" % (detail.get("positive_prompt") or ""))
print("OK", out["id"], out["filename"]) 
