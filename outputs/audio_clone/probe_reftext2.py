import json, io
for p in [r"F:\常用\闪寻音频.json", r"backend\app\bundled_workflows\qwen3-tts-voice-clone.json"]:
    d = json.load(io.open(p, encoding="utf-8"))
    wf = d.get("workflow", d)
    print("=====", p)
    for nid, n in wf.items():
        if n.get("class_type") in ("Qwen3VoiceClone", "LoadAudio", "SaveAudioAdvanced"):
            print(nid, n["class_type"])
            for k, v in n["inputs"].items():
                s = json.dumps(v, ensure_ascii=False)
                print("   ", k, "=", s[:160])
