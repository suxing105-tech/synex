"""提示词优化技能：种子自愈、增删改、导入、默认技能，以及一次优化的请求长什么样。

优化会真的打模型，所以一律打桩 reverse_prompts.request_model：断言的是「我们到底拼了
什么请求出去」——引用标记的规则、图的编号、输出形态。真发请求既花钱也测不到这些。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import prompt_skills as service
from app import reverse_prompts
from app.routes import reverse_prompts as reverse_routes
from app.routes.prompt_skills import router


@pytest.fixture
def client(init_db):
    app = FastAPI()
    app.include_router(router)
    # 模型配置和反推默认模型挂的是反推那一套接口：优化直接吃它，测试就得一起挂上
    app.include_router(reverse_routes.router)
    with TestClient(app) as client:
        yield client


def make_image(init_db, tmp_path, name="ref.png", size=(24, 16)):
    path = tmp_path / name
    Image.new("RGBA", size, (200, 30, 30, 255)).save(path)
    return init_db.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes) VALUES(?,?,?,?)",
        (str(path), path.name, path.stat().st_mtime, path.stat().st_size),
    ).lastrowid


@pytest.fixture
def model(client):
    """配好一家服务商并把它设成反推的默认模型——优化只认这一处配置。"""
    config = client.post("/api/model-configs", json={
        "name": "视觉模型", "base_url": "https://example.com/api/v1", "model": "vision-pro", "timeout": 60,
    }).json()
    client.put("/api/reverse-prompt-settings", json={"default_model_id": config["id"], "instruction": "反推用的指令"})
    return config


def builtin_id(client, key):
    rows = client.get("/api/prompt-skills").json()
    return next(row["id"] for row in rows if row["builtin_key"] == key)


# ---------- 内置技能：开箱可用，改得动，删不掉 ----------


def test_new_db_gets_two_builtin_skills(client):
    rows = client.get("/api/prompt-skills").json()
    assert [row["builtin_key"] for row in rows] == ["image_default", "video_default"]
    image, video = rows
    assert image["kinds"] == ["image"] and image["with_refs"] is True
    assert video["kinds"] == ["video"]
    # 内置技能的写法得有真正的正事，否则等于给了条空技能
    assert "生图" in image["instruction"] and "镜头" in video["instruction"]
    assert client.get("/api/prompt-skill-settings").json() == {"default_image_skill": None,
                                                              "default_video_skill": None}


def test_initialize_heals_missing_seed_and_keeps_user_edits(init_db, client):
    skill_id = builtin_id(client, "video_default")
    client.patch(f"/api/prompt-skills/{skill_id}", json={"instruction": "我自己的视频写法", "name": "我的视频"})
    # 老库升级、或者有人直接删了那一行：再跑一次 initialize 只补少的，不动改过的
    init_db.main().execute("DELETE FROM prompt_skills WHERE builtin_key='image_default'")
    service.initialize(init_db.main())
    rows = client.get("/api/prompt-skills").json()
    # 补齐按 builtin_key 回到自己原来那一档，不 appended 到末尾：内置两族的先后顺序是定的
    assert [row["builtin_key"] for row in rows] == ["image_default", "video_default"]
    healed = next(row for row in rows if row["builtin_key"] == "image_default")
    assert healed["instruction"] == service.DEFAULT_IMAGE_INSTRUCTION
    edited = next(row for row in rows if row["builtin_key"] == "video_default")
    assert edited["instruction"] == "我自己的视频写法" and edited["name"] == "我的视频"
    assert healed["sort"] == 10 and edited["sort"] == 20, "补齐只回自己那一档，不许挪别人排好的顺序"


def test_builtin_can_be_rewritten_and_restored(client):
    skill_id = builtin_id(client, "image_default")
    changed = client.patch(f"/api/prompt-skills/{skill_id}",
                           json={"instruction": "只把它变短一点", "language": "en", "with_refs": False}).json()
    assert changed["instruction"] == "只把它变短一点" and changed["language"] == "en"
    assert changed["with_refs"] is False
    restored = client.post(f"/api/prompt-skills/{skill_id}/restore-default").json()
    assert restored["instruction"] == service.DEFAULT_IMAGE_INSTRUCTION
    assert restored["language"] == "auto" and restored["with_refs"] is True


def test_builtin_delete_is_refused_and_custom_delete_works(client):
    builtin = builtin_id(client, "image_default")
    refused = client.delete(f"/api/prompt-skills/{builtin}")
    assert refused.status_code == 409 and "内置" in refused.json()["detail"]
    created = client.post("/api/prompt-skills", json={"name": "我的写法", "instruction": "变短"}).json()
    assert client.delete(f"/api/prompt-skills/{created['id']}").json() == {"deleted": created["id"]}
    assert client.delete(f"/api/prompt-skills/{created['id']}").status_code == 404


def test_patch_only_touches_given_fields(client):
    created = client.post("/api/prompt-skills", json={
        "name": "电商主图", "note": "白底、主体居中", "kinds": ["image"], "instruction": "原写法",
        "language": "zh", "with_refs": False,
    }).json()
    patched = client.patch(f"/api/prompt-skills/{created['id']}", json={"note": "换个说明"}).json()
    assert patched["note"] == "换个说明" and patched["instruction"] == created["instruction"]
    assert patched["name"] == created["name"] and patched["with_refs"] is False
    assert patched["updated_at"] >= created["updated_at"]


def test_validation_rejects_empty_instruction_and_unknown_kind(client):
    assert client.post("/api/prompt-skills", json={"name": "空的", "instruction": "   "}).status_code == 422
    assert client.post("/api/prompt-skills", json={"name": "没这族", "instruction": "写",
                                                   "kinds": ["audio"]}).status_code == 422
    builtin = builtin_id(client, "image_default")
    assert client.patch(f"/api/prompt-skills/{builtin}", json={"language": "fr"}).status_code == 422


# ---------- 从文件导入 SKILL.md ----------


def test_import_strips_frontmatter_and_takes_name(client):
    content = "---\nname: 商业产品视觉\ndescription: 七模块提示词\n---\n\n# 标题\n\n先建立设计语言基线。"
    result = client.post("/api/prompt-skills/import", json={"filename": "commercial-visual-prompt.md",
                                                            "content": content}).json()
    assert result["name"] == "商业产品视觉"
    assert result["truncated"] is False
    assert result["instruction"].startswith("# 标题")
    assert "description:" not in result["instruction"]
    assert result["note"] == "从文件导入"


def test_import_falls_back_to_heading_then_filename(client):
    by_heading = client.post("/api/prompt-skills/import", json={"content": "# 分镜提示词写法\n正文"}).json()
    assert by_heading["name"] == "分镜提示词写法"
    by_file = client.post("/api/prompt-skills/import",
                          json={"filename": "C:/skills/h3-prompt-writing/SKILL.md", "content": "只有正文"}).json()
    assert by_file["name"] == "SKILL"
    # 撞名不报错，加序号：一次挑两份同名文件是常见操作
    again = client.post("/api/prompt-skills/import",
                        json={"filename": "D:/other/h3/SKILL.md", "content": "另一份正文"}).json()
    assert again["name"] == "SKILL (2)" and again["id"] != by_file["id"]


def test_import_truncates_long_skill(client, monkeypatch):
    monkeypatch.setattr(service, "MAX_IMPORT_CHARS", 60)
    content = "---\nname: 长文档\n---\n" + ("内容段落。\n" * 100)
    result = client.post("/api/prompt-skills/import", json={"content": content}).json()
    assert result["truncated"] is True
    assert result["instruction"].endswith("（技能原文过长，到这里为止。）")
    assert len(result["instruction"]) <= 60 + len("\n\n（技能原文过长，到这里为止。）")


def test_import_rejects_bodyless_file(client):
    assert client.post("/api/prompt-skills/import", json={"content": "---\nname: x\n---\n"}).status_code == 422


# ---------- 两族的默认技能 ----------


def test_default_skills_are_saved_per_family_and_follow_deletion(client):
    image = builtin_id(client, "image_default")
    video = builtin_id(client, "video_default")
    saved = client.put("/api/prompt-skill-settings",
                       json={"default_image_skill": image, "default_video_skill": video}).json()
    assert saved == {"default_image_skill": image, "default_video_skill": video}
    # 视频技能当图片默认：点了会跑错一族，直接拒
    assert client.put("/api/prompt-skill-settings", json={"default_image_skill": video}).status_code == 422
    # 内置删不掉，那就建一条自定义的当默认再删：外键自己把默认置空，界面不至于指着不存在的技能
    custom = client.post("/api/prompt-skills", json={"name": "临时", "kinds": ["video"],
                                                    "instruction": "写"}).json()
    client.put("/api/prompt-skill-settings", json={"default_image_skill": image,
                                                   "default_video_skill": custom["id"]})
    client.delete(f"/api/prompt-skills/{custom['id']}")
    assert client.get("/api/prompt-skill-settings").json()["default_video_skill"] is None


# ---------- 一次优化：拼出去长什么样 ----------


class Capture:
    def __init__(self, answer="优化后的正文"):
        self.answer = answer
        self.calls: list[dict] = []

    async def __call__(self, config, key, content, instruction, output_rule=""):
        self.calls.append({"config": config, "key": key, "content": content,
                           "instruction": instruction, "output_rule": output_rule})
        return self.answer


def optimize(client, skill_id, prompt="一张猫 @图片1 坐在 @图片3 上", kind="image", refs=None):
    return client.post(f"/api/prompt-skills/{skill_id}/optimize",
                       json={"prompt": prompt, "kind": kind, "refs": refs or []})


def test_optimize_sends_mark_rule_and_image_ordinals(client, model, init_db, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    first, third = make_image(init_db, tmp_path, "a.png"), make_image(init_db, tmp_path, "c.png")
    skill_id = builtin_id(client, "image_default")
    result = optimize(client, skill_id, refs=[{"ordinal": 3, "image_id": third},
                                              {"ordinal": 1, "image_id": first}])
    assert result.status_code == 200, result.text
    assert result.json() == {"prompt": "优化后的正文", "model_name": "视觉模型", "model": "vision-pro",
                             "degraded_refs": None}
    call = capture.calls[0]
    # 模型继续吃反推那套配置，不另开一份
    assert call["config"]["model"] == "vision-pro" and call["key"] == ""
    texts = [part["text"] for part in call["content"] if part["type"] == "text"]
    images = [part for part in call["content"] if part["type"] == "image_url"]
    assert len(images) == 2 and images[0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    # 编号跟着格子走：@图片1 的图必须标成 图1，中间空了第 2 格也不许整体往前挪
    assert "图1" in texts and "图3" in texts
    assert texts.index("图1") < texts.index("图3") < texts.index("待优化的提示词：")
    assert call["content"][-1]["text"] == "一张猫 @图片1 坐在 @图片3 上"
    assert call["output_rule"] == ""
    # 硬规矩拼在 system 里，而且技能正文在最前面
    assert call["instruction"].startswith(service.DEFAULT_IMAGE_INSTRUCTION)
    for mark in ("@图片1", "<Picture 1>", "<Audio 2>"):
        assert mark in call["instruction"]
    assert "输出语言跟随原文" in call["instruction"] and "只返回优化后的提示词正文" in call["instruction"]


def test_optimize_respects_with_refs_and_language(client, model, init_db, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    image_id = make_image(init_db, tmp_path)
    skill_id = builtin_id(client, "image_default")
    client.patch(f"/api/prompt-skills/{skill_id}", json={"with_refs": False, "language": "zh"})
    result = optimize(client, skill_id, refs=[{"ordinal": 1, "image_id": image_id}])
    assert result.status_code == 200
    call = capture.calls[0]
    assert [part for part in call["content"] if part["type"] == "image_url"] == []
    assert call["content"][0]["text"] == "待优化的提示词："
    assert "输出中文。" in call["instruction"] and "Output in English" not in call["instruction"]


def test_optimize_skips_broken_refs_and_degrades_when_too_big(client, model, init_db, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    good = make_image(init_db, tmp_path, "good.png")
    missing = init_db.main().execute(
        "INSERT INTO images(path,filename,mtime,size_bytes) VALUES(?,?,?,?)",
        (str(tmp_path / "gone.png"), "gone.png", 0, 0)).lastrowid
    monkeypatch.setattr(service, "MAX_REF_PAYLOAD", 200)
    result = optimize(client, builtin_id(client, "image_default"),
                      refs=[{"ordinal": 1, "image_id": good}, {"ordinal": 2, "image_id": missing},
                            {"ordinal": 3, "image_id": good}])
    assert result.status_code == 200, result.text
    # 第 2 格的文件没了、第 3 格超总长：两次都得点名，但优化照样出结果
    assert result.json()["degraded_refs"] == {"sent": 1, "dropped": [2, 3]}
    texts = [part["text"] for part in capture.calls[0]["content"] if part["type"] == "text"]
    assert "图1" in texts and "图2" not in texts and "图3" not in texts


def test_optimize_refuses_wrong_family_empty_prompt_and_missing_model(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    image_skill = builtin_id(client, "image_default")
    wrong = optimize(client, image_skill, kind="video")
    assert wrong.status_code == 422 and "视频" in wrong.json()["detail"]
    empty = optimize(client, image_skill, prompt="   ")
    assert empty.status_code == 422 and capture.calls == []
    # 没配模型：说人话，并指出去哪儿配
    client.put("/api/reverse-prompt-settings", json={"default_model_id": None, "instruction": "反推用的指令"})
    nomodel = optimize(client, image_skill)
    assert nomodel.status_code == 422 and "反推提示词" in nomodel.json()["detail"]


def test_optimize_strips_wrappers_without_editing_the_body(client, model, monkeypatch):
    # 代码块那三个反引号用 chr 拼：写成字面量在测试文件里读起来像三对引号打架
    fence = chr(96) * 3
    monkeypatch.setattr(reverse_prompts, "request_model",
                        Capture(fence + "text\n优化后的提示词：\n一只猫 @图片1 躺着\n" + fence + "\n"))
    assert optimize(client, builtin_id(client, "image_default")).json()["prompt"] == "一只猫 @图片1 躺着"
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("“一只猫 @图片1 躺着”"))
    assert optimize(client, builtin_id(client, "image_default")).json()["prompt"] == "一只猫 @图片1 躺着"
    # 正文里的换行是有意义的（分段＝分镜），剥壳不许把它们抹平
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("镜头一：推进。\n\n镜头二：拉起。\n"))
    assert optimize(client, builtin_id(client, "image_default")).json()["prompt"] == "镜头一：推进。\n\n镜头二：拉起。"
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("   \n" + fence + "\n\n" + fence + "  \n"))
    assert optimize(client, builtin_id(client, "image_default")).status_code == 502


def test_optimize_writes_nothing_to_the_database(client, model, init_db, tmp_path, monkeypatch):
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("正文"))
    image_id = make_image(init_db, tmp_path)

    def snapshot():
        return {table: init_db.main().execute("SELECT count(*) FROM " + table).fetchone()[0]
                for table in ("prompt_skills", "prompt_skill_settings", "reverse_prompts", "model_configs",
                              "images")}

    before = snapshot()
    client.put("/api/prompt-skill-settings", json={"default_image_skill": builtin_id(client, "image_default")})
    assert optimize(client, builtin_id(client, "image_default"),
                    refs=[{"ordinal": 1, "image_id": image_id}]).status_code == 200
    assert snapshot() == before, "优化是给建议，不该留下任何记录"


def test_helpers_stay_pure():
    assert service.clean_output("优化后的提示词：\n正文") == "正文"
    assert service.clean_output("正文") == "正文"
    # 「优化后的提示词：」出现在正文中间时是用户的话，不是壳，不许动
    assert service.clean_output("先写主体，再写「优化后的提示词：」这四个字") == "先写主体，再写「优化后的提示词：」这四个字"
    assert service.kinds_of("video,image") == ["image", "video"]
    assert service.kinds_of("audio") == ["image"], "认不出的值退回图片族，界面至少还有得选"
    assert service.system_prompt({"instruction": "写法", "language": "en"}).endswith("Output in English.")
    assert service.system_prompt({"instruction": "写法", "language": "怪"}).endswith("输出语言跟随原文：原文以中文为主就出中文，以英文为主就出英文。")
    with pytest.raises(HTTPException) as blocked:
        service.normalize_kinds([])
    assert blocked.value.status_code == 422
