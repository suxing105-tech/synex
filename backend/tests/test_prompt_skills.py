"""提示词优化技能：种子自愈、增删改、导入、默认技能，以及一次优化的请求长什么样。

优化会真的打模型，所以一律打桩 reverse_prompts.request_model：断言的是「我们到底拼了
什么请求出去」——引用标记的规则、图的编号、输出形态。真发请求既花钱也测不到这些。
"""
from __future__ import annotations

from pathlib import Path
import shutil
import zipfile

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app import bundled_skills
from app import prompt_skills as service
from app import reverse_prompts
from app import skill_packages
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


def test_new_db_gets_five_builtin_skills(client):
    rows = client.get("/api/prompt-skills").json()
    assert [row["builtin_key"] for row in rows] == [
        "image_default", "video_default", "qwen_image", "h3_image", "h3_video"]
    image, video, qwen, h3, h3v = rows
    # 名字也是出厂口径：2026-11-17 苏醒把两条通用的改成「通用优化」，「增强」听着像加料
    assert [row["name"] for row in rows] == [
        "图片通用优化", "视频通用优化", "Qwen-Image-2.1 优化", "H3-Image 优化", "闪寻视频生成H3优化"]
    assert image["kinds"] == ["image"] and image["with_refs"] is True
    assert video["kinds"] == ["video"]
    # 内置技能的写法得有真正的正事，否则等于给了条空技能
    assert "生图" in image["instruction"] and "镜头" in video["instruction"]
    # 按模型那两条也各有自己的正事：一条讲先判模式，一条讲带图时的编辑协议
    assert "文生图" in qwen["instruction"] and "负面提示词" in qwen["instruction"]
    assert "Subject" in h3["instruction"]
    # 第五条只认视频：把它挂到图片提示词上，出来的就是六段协议那套没人要的东西
    assert h3v["kinds"] == ["video"]
    # 正文的立身之本是那个戏种开关，认不出戏种这条技能就没意义
    assert "武戏" in h3v["instruction"] and "文戏" in h3v["instruction"]
    # 默认指针还是空的：出厂默认是通用那两条，按模型挑是使用时的选择，不是出厂选择
    assert client.get("/api/prompt-skill-settings").json() == {"default_image_skill": None,
                                                              "default_video_skill": None}


def test_initialize_heals_missing_seed_and_keeps_user_edits(init_db, client):
    skill_id = builtin_id(client, "video_default")
    client.patch(f"/api/prompt-skills/{skill_id}", json={"instruction": "我自己的视频写法", "name": "我的视频"})
    # 老库升级、或者有人直接删了那一行：再跑一次 initialize 只补少的，不动改过的
    init_db.main().execute("DELETE FROM prompt_skills WHERE builtin_key='image_default'")
    service.initialize(init_db.main())
    rows = client.get("/api/prompt-skills").json()
    # 补齐按 builtin_key 回到自己原来那一档，不 appended 到末尾：内置那几条的先后顺序是定的
    assert [row["builtin_key"] for row in rows] == [
        "image_default", "video_default", "qwen_image", "h3_image", "h3_video"]
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


# ---------- 导入一份 SKILL.md ----------


def test_import_strips_frontmatter_and_takes_name(client):
    content = "---\nname: 商业产品视觉\ndescription: 反推模板与提示词\n---\n\n# 正文\n\n先把主体和光线说清。"
    result = client.post("/api/prompt-skills/import", json={"filename": "commercial-visual-prompt.md",
                                                            "content": content})
    skill = only_imported(result)
    assert skill["name"] == "商业产品视觉"
    assert skill["replaced"] is False
    assert skill["instruction"].startswith("# 正文")
    assert "description:" not in skill["instruction"]
    assert skill["note"] == "从文件导入"


def test_import_falls_back_to_heading_then_filename(client):
    by_heading = only_imported(client.post("/api/prompt-skills/import",
                                           json={"content": "# 分镜提示词写法\n正文"}))
    assert by_heading["name"] == "分镜提示词写法"
    by_file = only_imported(client.post("/api/prompt-skills/import",
                                        json={"filename": "C:/skills/h3-prompt-writing/SKILL.md",
                                              "content": "只有正文"}))
    assert by_file["name"] == "SKILL"
    # 同名文件很常见：拿到「另存一条」才加序号，两份都留着
    again = only_imported(client.post("/api/prompt-skills/import", json={
        "filename": "D:/other/h3/SKILL.md", "content": "另一条正文", "on_conflict": "new"}))
    assert again["name"] == "SKILL (2)" and again["id"] != by_file["id"]


def test_import_asks_before_replacing_a_file_of_the_same_name(client):
    first = only_imported(client.post("/api/prompt-skills/import",
                                      json={"filename": "SKILL.md", "content": "# 甲\n\n第一版。"}))
    result = client.post("/api/prompt-skills/import",
                         json={"filename": "SKILL.md", "content": "# 甲\n\n第二版。"})
    data = result.json()
    assert data["imported"] == [] and data["conflicts"][0]["existing_id"] == first["id"]
    replaced = only_imported(client.post("/api/prompt-skills/import", json={
        "filename": "SKILL.md", "content": "# 甲\n\n第二版。", "on_conflict": "replace"}))
    assert replaced["id"] == first["id"] and replaced["replaced"] is True
    assert "第二版" in replaced["instruction"]


def test_a_long_skill_imports_whole(client):
    """长原文整篇进来：不切、不加「到这里为止」那句尾巴。

    2026-11-16 苏醒「我希望技能包完整加载，不删技能原文」。以前超 12000 字就切一刀，
    切完只在正文末尾留一句说明——界面上那一句被当成技能的一部分，改都改不掉。
    """
    unit = "内容段落。\n"
    content = "---\nname: 长文档\n---\n" + (unit * 8000)
    skill = only_imported(client.post("/api/prompt-skills/import", json={"content": content}))
    assert "技能原文过长" not in skill["instruction"]
    assert skill["instruction"].endswith("内容段落。")
    assert len(skill["instruction"]) == len(unit) * 8000 - 1  # 只有结尾那个换行被 strip


def test_an_overlong_source_is_refused_by_name_not_quietly_cut(client, monkeypatch):
    """真超上限（例如塞进来一份不是技能的大文件）：报名字拒收，而不是偷偷少一截。"""
    monkeypatch.setattr(service, "MAX_INSTRUCTION", 200)
    content = "---\nname: 超大\n---\n" + ("字" * 5000)
    result = client.post("/api/prompt-skills/import",
                         json={"filename": "big.md", "content": content}).json()
    assert result["imported"] == []
    assert result["skipped"][0]["path"] == "big.md"
    assert "技能写法最长 200 字" in result["skipped"][0]["reason"]


def test_replacing_with_an_overlong_package_leaves_the_old_one_intact(client, tmp_path, monkeypatch):
    """换成一条超长的技能包：一个字都不许动，旧包还在盘上。

    替换那一路是「新包先顶掉旧目录，再写库」。少了正文长度这道先验，
    save_skill 拒收时旧包已经被人原来能用的那一份没了。
    """
    first = only_imported(import_paths(client, make_package(tmp_path / "first", name="甲",
                                                            body="# 甲\n\n原来那一版。")))
    monkeypatch.setattr(service, "MAX_INSTRUCTION", 200)
    big = make_package(tmp_path / "big", name="甲", body="# 甲\n\n" + ("正文。" * 300))
    data = import_paths(client, big, on_conflict="replace").json()
    assert data["imported"] == [] and data["conflicts"] == []
    assert "上限 200 字" in data["skipped"][0]["reason"]
    kept = next(item for item in client.get("/api/prompt-skills").json() if item["id"] == first["id"])
    assert "原来那一版" in kept["instruction"]
    assert "原来那一版" in (Path(first["package_dir"]) / "SKILL.md").read_text(encoding="utf-8")


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


def optimize(client, skill_id, prompt="一张猫 @图片1 坐在 @图片3 上", kind="image", refs=None,
             send_context=None, send_scene=None):
    body = {"prompt": prompt, "kind": kind, "refs": refs or []}
    if send_context is not None:
        body["context"] = send_context
    if send_scene is not None:
        body["scene_type"] = send_scene
    return client.post(f"/api/prompt-skills/{skill_id}/optimize", json=body)


def test_optimize_sends_mark_rule_and_image_ordinals(client, model, init_db, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    first, third = make_image(init_db, tmp_path, "a.png"), make_image(init_db, tmp_path, "c.png")
    skill_id = builtin_id(client, "image_default")
    result = optimize(client, skill_id, refs=[{"ordinal": 3, "image_id": third},
                                              {"ordinal": 1, "image_id": first}])
    assert result.status_code == 200, result.text
    # omitted_refs 是 None：这条不是认戏种的那条内置，资料一块都没少带（要求 2 的口径）
    assert result.json() == {"prompt": "优化后的正文", "model_name": "视觉模型", "model": "vision-pro",
                             "degraded_refs": None, "omitted_refs": None}
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


# ---------- 技能包（Codex 那种一整个目录） ----------


def make_package(root, name="电商视觉包", body="# 电商视觉包\n\n先定光，再定镜头。",
                 description="影驰电商主图的写法", extra=None, binary=None):
    """在 root 下铺一个技能包目录，返回它的根路径。"""
    root = Path(root)
    (root / "references").mkdir(parents=True, exist_ok=True)
    front = "---\nname: " + name + "\ndescription: " + description + "\nlicense: MIT\n"
    front += "allowed-tools: [Read, Write]\n---\n\n"
    (root / "SKILL.md").write_text(front + body, encoding="utf-8")
    files = {"references/style.md": "金属质感要写清楚反射。"} if extra is None else extra
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for rel, blob in (binary or {}).items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    return root


def import_paths(client, *paths, on_conflict="ask"):
    """导入那一个入口：桌面版给的是路径，md、.zip、一整个目录都从这儿走。"""
    return client.post("/api/prompt-skills/import-path",
                       json={"paths": [str(item) for item in paths], "on_conflict": on_conflict})


def only_imported(result):
    """「这次干净地只进了一条」——大部分用例要的就是这个形状。"""
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["conflicts"] == [], data
    assert len(data["imported"]) == 1, data
    return data["imported"][0]


def make_zip(root, name="pack.zip"):
    """把一个目录原样压成 .zip，里面照惯例套一层同名目录。"""
    root = Path(root)
    target = root.parent / name
    with zipfile.ZipFile(target, "w") as archive:
        for item in sorted(root.rglob("*")):
            if item.is_dir():
                continue
            archive.write(item, item.relative_to(root.parent).as_posix())
    return target


def test_package_import_reads_frontmatter_body_and_text_files(client, tmp_path):
    root = make_package(tmp_path / "shop-skill")
    data = only_imported(import_paths(client, root))
    assert data["name"] == "电商视觉包"
    assert data["source"] == "package"
    # frontmatter 剥掉，description 落到「一句话说明」，正文才是指令
    assert data["instruction"].startswith("# 电商视觉包")
    assert "description:" not in data["instruction"]
    assert data["note"] == "影驰电商主图的写法"
    package = data["package"]
    assert package["license"] == "MIT"
    assert package["allowed_tools"] == ["Read", "Write"]
    # 来源路径记下来了，下次重导同一个包才认得出「这是同一条的上一版」
    assert package["source_dir"] == str(root)
    paths = {item["path"] for item in package["files"]}
    assert paths == {"SKILL.md", "references/style.md"}
    included = {item["path"] for item in package["files"] if item["included"]}
    assert included == {"references/style.md"}


def test_package_without_skill_md_is_refused(client, tmp_path):
    empty = tmp_path / "no-skill"
    empty.mkdir()
    (empty / "readme.md").write_text("这里没有 SKILL.md", encoding="utf-8")
    result = import_paths(client, empty)
    assert result.status_code == 422 and "SKILL.md" in result.json()["detail"]


def test_package_scan_skips_hidden_dirs_and_node_modules(client, tmp_path):
    root = make_package(tmp_path / "pack")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("不该被读到", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "left-pad.js").write_text("也不该被读到", encoding="utf-8")
    paths = {item["path"] for item in only_imported(import_paths(client, root))["package"]["files"]}
    assert ".git/config" not in paths and "node_modules/left-pad.js" not in paths


def test_package_binary_files_are_listed_but_not_sent(client, tmp_path):
    root = make_package(tmp_path / "pack", binary={"assets/palette.png": b"\x89PNG\r\n\x1a\n"})
    files = {item["path"]: item for item in only_imported(import_paths(client, root))["package"]["files"]}
    assert files["assets/palette.png"]["included"] is False
    assert files["assets/palette.png"]["role"] == "资源"
    assert "二进制" in files["assets/palette.png"]["reason"]


def test_bom_before_frontmatter_does_not_leak_into_the_instruction(client, tmp_path):
    # 记事本存出来的就是带 BOM 的。BOM 在正则里不算空白，
    # 认不出来整段 frontmatter 就会被当成正文发给模型，还会顶在最前面。
    root = tmp_path / "bom"
    (root / "references").mkdir(parents=True)
    (root / "SKILL.md").write_text("---\nname: 带BOM的包\n---\n\n# 带BOM的包\n\n正文。",
                                   encoding="utf-8-sig")
    (root / "references" / "style.md").write_text("带 BOM 的资料。", encoding="utf-8-sig")
    skill = only_imported(import_paths(client, root))
    assert skill["name"] == "带BOM的包"
    assert skill["note"] == ""
    assert skill["instruction"].startswith("# 带BOM的包")
    assert "\ufeff" not in skill["instruction"]


def test_gbk_encoded_skill_md_file_is_still_readable(client, tmp_path):
    path = tmp_path / "旧笔记.md"
    path.write_bytes("# 旧笔记\n\n这是 GBK 写的说明。".encode("gbk"))
    skill = only_imported(import_paths(client, path))
    assert skill["name"] == "旧笔记"
    assert "GBK 写的说明" in skill["instruction"]


def test_long_skill_name_is_cut_short_not_refused(client, tmp_path):
    root = make_package(tmp_path / "pack", name="很长的技能名字" * 12)
    skill = only_imported(import_paths(client, root))
    assert 0 < len(skill["name"]) <= service.MAX_NAME


def test_zip_names_packed_in_gbk_are_decoded():
    # 打包工具没置 UTF-8 标记时，zipfile 已经按 cp437 替我们解过一遍，
    # 名字得编回原字节再按 GBK 认回来。这一步错了，界面上就是一串乱码文件名，
    # 子目录里的 SKILL.md 也会整个认不出来。
    gbk = zipfile.ZipInfo("技能包/参考资料/写法.md".encode("gbk").decode("cp437"))
    assert skill_packages.zip_entry_name(gbk) == "技能包/参考资料/写法.md"
    flagged = zipfile.ZipInfo("技能包/写法.md")
    flagged.flag_bits |= 0x800
    assert skill_packages.zip_entry_name(flagged) == "技能包/写法.md"


def test_package_refs_are_budgeted_and_referenced_files_win(client, tmp_path, monkeypatch):
    monkeypatch.setattr(skill_packages, "MAX_REFS_CHARS", 120)
    root = make_package(tmp_path / "pack",
                        body="# 正文\n\n先看 references/wanted.md，其余随便。",
                        extra={"references/wanted.md": "甲" * 80,
                               "references/other.md": "乙" * 80})
    package = only_imported(import_paths(client, root))["package"]
    files = {item["path"]: item for item in package["files"]}
    # 正文点名过的那份先进来，而且是整份进来；另一份只能拿剩下的预算
    assert files["references/wanted.md"]["included"] is True
    assert files["references/wanted.md"]["truncated"] is False
    other = files["references/other.md"]
    assert other["included"] is False or other["truncated"] is True
    assert package["refs_chars"] <= skill_packages.MAX_REFS_CHARS


def test_package_refs_reach_the_model_in_the_right_order(client, model, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    root = make_package(tmp_path / "pack", body="# 电商视觉包\n\n细则见 references/style.md。",
                        extra={"references/style.md": "金属质感要写清楚反射。"})
    imported = only_imported(import_paths(client, root))
    result = optimize(client, imported["id"], prompt="一个显卡")
    assert result.status_code == 200, result.text
    instruction = capture.calls[0]["instruction"]
    # 顺序：正文 → 资料 → 硬规矩。硬规矩垫底，规矩被吞掉就会开始吃 @图片N
    assert instruction.startswith("# 电商视觉包")
    assert "金属质感要写清楚反射。" in instruction
    assert instruction.index("金属质感") < instruction.index("输出要求")
    assert "references/style.md" in instruction


def test_package_without_refs_keeps_the_old_system_prompt(client, model, tmp_path, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    root = make_package(tmp_path / "pack", extra={})
    imported = only_imported(import_paths(client, root))
    optimize(client, imported["id"], prompt="一个显卡")
    instruction = capture.calls[0]["instruction"]
    assert "技能包参考资料" not in instruction
    assert instruction.startswith("# 电商视觉包")


def test_package_refs_order_follows_how_specifically_the_body_names_them(client, tmp_path):
    root = make_package(tmp_path / "pack",
                        body="# 正文\n\n看 notes.md 与 style.md，其余在 references/ 里。",
                        extra={"notes.md": "甲", "deep/style.md": "乙",
                               "references/other.md": "丙", "unrelated.md": "丁"})
    imported = only_imported(import_paths(client, root))
    order = [item["path"] for item in sorted(imported["package"]["files"], key=lambda i: i.get("order") or 99)
             if item["included"]]
    # 点名越具体排得越前：写全路径 > 只写文件名 > 只指目录 > 没提到
    assert order.index("notes.md") < order.index("deep/style.md")
    assert order.index("deep/style.md") < order.index("references/other.md")
    assert order.index("references/other.md") < order.index("unrelated.md")


def test_nested_skill_md_counts_as_reference_not_as_the_instruction(client, tmp_path):
    # 包里套着别的技能（skills/other/SKILL.md）：根目录那条才是这条技能的写法
    root = make_package(tmp_path / "pack", extra={"skills/other/SKILL.md": "另一条技能的正文"})
    files = {item["path"]: item for item in only_imported(import_paths(client, root))["package"]["files"]}
    assert files["SKILL.md"]["role"] == "写法"
    assert files["skills/other/SKILL.md"]["role"] == "参考"
    assert files["skills/other/SKILL.md"]["included"] is True


def test_package_upload_channel_matches_path_channel(client, tmp_path):
    root = make_package(tmp_path / "pack")
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            files.append({"path": rel, "content": path.read_text(encoding="utf-8")})
    uploaded = only_imported(client.post("/api/prompt-skills/import-package/upload",
                                         json={"root": "pack", "files": files}))
    # 同一个包导第二次会先问；这里要比的是两条通道的内容，所以明说「另存一条」
    from_path = only_imported(import_paths(client, root, on_conflict="new"))
    assert uploaded["name"].split(" (")[0] == from_path["name"].split(" (")[0]
    assert uploaded["instruction"] == from_path["instruction"]
    assert {item["path"] for item in uploaded["package"]["files"]} == {
        item["path"] for item in from_path["package"]["files"]}


def test_deleting_a_package_skill_removes_its_folder(client, tmp_path):
    root = make_package(tmp_path / "pack")
    imported = only_imported(import_paths(client, root))
    package_dir = Path(imported["package_dir"])
    assert package_dir.exists() and (package_dir / "SKILL.md").exists()
    client.delete("/api/prompt-skills/" + str(imported["id"]))
    assert not package_dir.exists(), "包是随这条技能一起进来的，删技能就该一起带走"


def test_deleting_a_plain_skill_leaves_other_folders_alone(client, tmp_path):
    created = client.post("/api/prompt-skills", json={"name": "普通技能", "instruction": "写"}).json()
    assert client.delete("/api/prompt-skills/" + str(created["id"])).status_code == 200


# ---------- 技能包落盘的目录名（2026-11-17 苏醒：光一个数字不合理）----------


def test_package_folder_is_named_after_the_package_not_the_row(client, tmp_path):
    """落盘目录用包自己的英文名：文件管理器里一排 1 2 3 4，没人分得出哪个是哪条。"""
    imported = only_imported(import_paths(client, make_package(tmp_path / "seekx-h3-image-prompt")))
    folder = Path(imported["package_dir"])
    assert folder.parent == service.skills_dir()
    assert folder.name == "seekx-h3-image-prompt"
    assert folder.name != str(imported["id"]), "不许再拿库里的行号当目录名"
    assert (folder / "references" / "style.md").exists(), "落盘的还是包原本那几样"


def test_package_folder_name_stays_the_same_after_a_replace(client, tmp_path):
    """换包仍落在同一个目录：换一次多一个目录，skills/ 底下很快就没人认得哪份是活的。"""
    first = only_imported(import_paths(client, make_package(tmp_path / "seekx-pack")))
    again = only_imported(import_paths(
        client, make_package(tmp_path / "seekx-pack", body="# 换一版\n\n新写法。"),
        on_conflict="replace"))
    assert again["package_dir"] == first["package_dir"]
    assert "新写法" in (Path(again["package_dir"]) / "SKILL.md").read_text(encoding="utf-8")
    staging = service.skills_dir() / "seekx-pack.new"
    assert not staging.exists(), "换完不许留一份中间目录"


def test_two_packages_of_the_same_name_do_not_share_a_folder(client, tmp_path):
    """两条技能同名：后那条让开一档加行号，谁包里的 SKILL.md 都不许被顶掉。"""
    first = only_imported(import_paths(client, make_package(tmp_path / "seekx-pack")))
    second = only_imported(import_paths(
        client, make_package(tmp_path / "seekx-pack", name="另一条写法",
                             body="# 另一条写法\n\n另一套写法。"), on_conflict="new"))
    assert Path(second["package_dir"]).name == f"seekx-pack-{second['id']}"
    assert "先定光" in (Path(first["package_dir"]) / "SKILL.md").read_text(encoding="utf-8")
    assert "另一套写法" in (Path(second["package_dir"]) / "SKILL.md").read_text(encoding="utf-8")


def test_package_dir_slug_rules():
    slug = service.package_dir_slug
    assert slug("seekx-h3-image-prompt") == "seekx-h3-image-prompt"
    assert slug("  SeekX Pack 2 ") == "SeekX-Pack-2", "空格换成分隔符，首尾的空白与点去掉"
    assert slug("ｓｅｅｋｘ-pack") == "seekx-pack", "全角字母先归半角"
    assert slug("pack:v1/name*") == "pack-v1-name", "Windows 不许的字符一律换掉"
    assert slug("...") == "" and slug("") == "" and slug(None) == ""
    assert slug("nul") == "pkg-nul", "保留设备名不能当目录名"
    assert len(slug("x" * 200)) <= service.PACKAGE_DIR_MAX


def test_chinese_only_package_folder_falls_back_to_the_row(client, tmp_path):
    """整个包目录就叫中文名：洗不出可用字符，宁可退回行号，也不自己编一个英文名字。"""
    imported = only_imported(import_paths(client, make_package(tmp_path / "电商视觉包")))
    assert Path(imported["package_dir"]).name == str(imported["id"])
    assert (Path(imported["package_dir"]) / "SKILL.md").exists()


def test_old_numeric_folder_is_renamed_when_the_list_is_read(client, tmp_path, init_db):
    """老库里那条 skills/<行号>：下一次列清单就改成英文名，库里记的路径一起换。

    「在文件夹中显示」吃的正是库里那一个值，两边必须同时换，不许一个新一旧。
    """
    imported = only_imported(import_paths(client, make_package(tmp_path / "seekx-old-pack")))
    numeric = service.skills_dir() / str(imported["id"])
    Path(imported["package_dir"]).rename(numeric)      # 演一遍老库那一代
    init_db.main().execute("UPDATE prompt_skills SET package_dir=? WHERE id=?",
                           (str(numeric), imported["id"]))

    row = next(r for r in client.get("/api/prompt-skills").json() if r["id"] == imported["id"])
    assert Path(row["package_dir"]).name == "seekx-old-pack"
    assert (service.skills_dir() / "seekx-old-pack" / "SKILL.md").exists()
    assert not numeric.exists(), "改完不许留一个空壳在原地"

    # 再拉一次清单：已经认不出「数字那一代」，既不该再动，也不该被 prune 当成删了
    again = next(r for r in client.get("/api/prompt-skills").json() if r["id"] == imported["id"])
    assert again["package_dir"] == row["package_dir"]


def test_old_numeric_folder_rename_lets_a_foreign_dir_have_the_name(client, tmp_path, init_db):
    """正名被人占着（他自己往 skills/ 里放了一个同名目录）：让一档加行号，不覆盖别人的东西。"""
    imported = only_imported(import_paths(client, make_package(tmp_path / "seekx-taken")))
    numeric = service.skills_dir() / str(imported["id"])
    Path(imported["package_dir"]).rename(numeric)
    squatter = service.skills_dir() / "seekx-taken"
    squatter.mkdir()
    (squatter / "我的东西.txt").write_text("不是技能包", encoding="utf-8")
    init_db.main().execute("UPDATE prompt_skills SET package_dir=? WHERE id=?",
                           (str(numeric), imported["id"]))

    row = next(r for r in client.get("/api/prompt-skills").json() if r["id"] == imported["id"])
    assert Path(row["package_dir"]).name == f"seekx-taken-{imported['id']}"
    assert (Path(row["package_dir"]) / "SKILL.md").exists(), "搬过去的是这一条自己的包"
    assert (squatter / "我的东西.txt").read_text(encoding="utf-8") == "不是技能包", "不许动别人的目录"
    assert not numeric.exists()


def test_old_numeric_folder_stays_when_both_names_are_taken(client, tmp_path, init_db):
    """连让一档那一格也被占：整条不动。旧路径照样打得开，比留下一个坏状态好。"""
    imported = only_imported(import_paths(client, make_package(tmp_path / "seekx-full")))
    numeric = service.skills_dir() / str(imported["id"])
    Path(imported["package_dir"]).rename(numeric)
    (service.skills_dir() / "seekx-full").mkdir()
    (service.skills_dir() / f"seekx-full-{imported['id']}").mkdir()
    init_db.main().execute("UPDATE prompt_skills SET package_dir=? WHERE id=?",
                           (str(numeric), imported["id"]))

    row = next(r for r in client.get("/api/prompt-skills").json() if r["id"] == imported["id"])
    assert row["package_dir"] == str(numeric)
    assert (numeric / "SKILL.md").exists()


# ---------- 压缩包、SKILL.md 自动升级、一摞技能 ----------


def test_importing_a_zip_gets_the_same_skill_as_the_folder(client, tmp_path):
    blob = b"\x89PNG\r\n\x1a\n"
    root = make_package(tmp_path / "pack", binary={"assets/palette.png": blob})
    folder = only_imported(import_paths(client, root))
    from_zip = only_imported(import_paths(client, make_zip(root), on_conflict="new"))
    assert from_zip["name"].split(" (")[0] == folder["name"]
    assert from_zip["instruction"] == folder["instruction"]
    assert ({item["path"] for item in from_zip["package"]["files"]}
            == {item["path"] for item in folder["package"]["files"]})
    # 二进制得从压缩包里原样写回落盘目录，不能只登记一个名字
    assert (Path(from_zip["package_dir"]) / "assets" / "palette.png").read_bytes() == blob


def test_picking_skill_md_imports_the_package_around_it(client, tmp_path):
    root = make_package(tmp_path / "pack")
    skill = only_imported(import_paths(client, root / "SKILL.md"))
    paths = {item["path"] for item in skill["package"]["files"]}
    assert "references/style.md" in paths, "挑的是入口文件，参考资料不能悄悄丢掉"
    assert skill["source"] == "package"
    assert skill["package"]["source_dir"] == str(root)


def test_zip_junk_entries_are_skipped_and_evil_paths_dropped(client, tmp_path):
    target = tmp_path / "junk.zip"
    with zipfile.ZipFile(target, "w") as archive:
        archive.writestr("pack/SKILL.md", "---\nname: 干净包\n---\n\n# 干净包\n\n正文。")
        archive.writestr("pack/references/style.md", "要留着")
        archive.writestr("pack/__MACOSX/._style.md", "mac 的资源分支")
        archive.writestr("pack/._SKILL.md", "mac 的分支")
        archive.writestr("pack/Thumbs.db", "缩略图缓存")
        archive.writestr("pack/../../evil.md", "想写到包外面")
        archive.writestr("outside.md", "包外面的文件")
    files = {item["path"] for item in only_imported(import_paths(client, target))["package"]["files"]}
    # .. 那种路径压根进不了清单（safe_rel_path 挡掉），mac 与缩略图缓存不算技能的一部分
    assert files == {"SKILL.md", "references/style.md"}


def test_other_archive_formats_are_named_not_guessed(client, tmp_path):
    rar = tmp_path / "旧技能.rar"
    rar.write_bytes(b"RAR64\x00not really")
    result = import_paths(client, rar)
    assert result.status_code == 422
    detail = result.json()["detail"]
    assert ".zip" in detail and "解压" in detail, detail


def test_bundle_zip_imports_every_skill_at_the_shallowest_level(client, tmp_path):
    bundle = tmp_path / "bundle"
    make_package(bundle / "alpha", name="甲技能", description="甲的说明")
    make_package(bundle / "beta", name="乙技能", description="乙的说明")
    (bundle / "README.md").write_text("一摞技能", encoding="utf-8")
    data = import_paths(client, make_zip(bundle, "bundle.zip")).json()
    assert {item["name"] for item in data["imported"]} == {"甲技能", "乙技能"}
    assert data["conflicts"] == [] and data["skipped"] == []
    for item in data["imported"]:
        paths = {entry["path"] for entry in item["package"]["files"]}
        # 每条只带自己那一摞文件，隔壁那条技能的 SKILL.md 不该混进来当参考
        assert "SKILL.md" in paths and not any(p.endswith("SKILL.md") for p in paths - {"SKILL.md"})


def test_a_mixed_batch_reports_what_it_skipped(client, tmp_path):
    root = make_package(tmp_path / "pack")
    note = tmp_path / "随手笔记.md"
    note.write_text("# 随手笔记\n\n一条都不相关的。", encoding="utf-8")
    rar = tmp_path / "旧技能.rar"
    rar.write_bytes(b"not a zip")
    doc = tmp_path / "说明.docx"
    doc.write_bytes(b"word")
    data = import_paths(client, root, note, rar, doc).json()
    assert len(data["imported"]) == 2, data
    assert {Path(item["path"]).name for item in data["skipped"]} == {"旧技能.rar", "说明.docx"}
    reasons = " ".join(item["reason"] for item in data["skipped"])
    assert "解压" in reasons and ".zip" in reasons


def test_archive_route_imports_an_uploaded_zip(client, tmp_path):
    root = make_package(tmp_path / "pack")
    target = make_zip(root)
    with open(target, "rb") as handle:
        blob = handle.read()
    result = client.post("/api/prompt-skills/import-archive",
                         files={"file": ("pack.zip", blob, "application/zip")})
    skill = only_imported(result)
    assert skill["name"] == "电商视觉包"
    assert skill["source"] == "package"
    assert (Path(skill["package_dir"]) / "SKILL.md").exists()


# ---------- 撞名：先问，再动手 ----------


def test_reimporting_the_same_folder_asks_before_touching_anything(client, tmp_path):
    root = make_package(tmp_path / "pack")
    first = only_imported(import_paths(client, root))
    before = client.get("/api/prompt-skills").json()
    data = import_paths(client, root).json()
    assert data["imported"] == [], "没拿到决定之前一条都不该写"
    assert data["conflicts"] == [{"name": "电商视觉包", "source_dir": str(root),
                                  "existing_id": first["id"], "existing_name": "电商视觉包"}]
    assert client.get("/api/prompt-skills").json() == before


def test_replacing_keeps_the_id_kinds_and_default_pointer(client, tmp_path):
    # 苏醒那条老抱怨：每次重导都得重新勾一遍「只勾图片 + 英文」。
    # 替换换的是内容，勾选、语言、默认指针一律不动。
    root = make_package(tmp_path / "pack")
    first = only_imported(import_paths(client, root))
    client.patch("/api/prompt-skills/" + str(first["id"]),
                 json={"kinds": ["image"], "language": "en", "with_refs": False})
    client.put("/api/prompt-skill-settings",
               json={"default_image_skill": first["id"], "default_video_skill": None})
    (root / "SKILL.md").write_text("---\nname: 电商视觉包\ndescription: 改了说法\n---\n\n"
                                   "# 电商视觉包\n\n先定色，再定光。", encoding="utf-8")
    after = only_imported(import_paths(client, root, on_conflict="replace"))
    assert after["id"] == first["id"] and after["replaced"] is True
    assert after["kinds"] == ["image"] and after["language"] == "en"
    assert after["with_refs"] is False
    assert after["note"] == "改了说法"
    assert "先定色" in after["instruction"] and "先定镜头" not in after["instruction"]
    settings = client.get("/api/prompt-skill-settings").json()
    assert settings["default_image_skill"] == first["id"], "默认指针不该因为换内容而断"


def test_replacing_swaps_the_package_folder_too(client, tmp_path):
    root = make_package(tmp_path / "pack", extra={"references/style.md": "旧版本"})
    first = only_imported(import_paths(client, root))
    folder = Path(first["package_dir"])
    (root / "references" / "style.md").write_text("新版本", encoding="utf-8")
    (root / "references" / "new.md").write_text("新增的一份", encoding="utf-8")
    after = only_imported(import_paths(client, root, on_conflict="replace"))
    assert after["package_dir"] == first["package_dir"], "同一条技能就用同一个目录"
    assert (folder / "references" / "style.md").read_text(encoding="utf-8") == "新版本"
    assert (folder / "references" / "new.md").exists()
    paths = {item["path"] for item in after["package"]["files"]}
    assert "references/new.md" in paths


def test_import_new_mode_keeps_both_copies(client, tmp_path):
    root = make_package(tmp_path / "pack")
    first = only_imported(import_paths(client, root))
    second = only_imported(import_paths(client, root, on_conflict="new"))
    assert second["id"] != first["id"]
    assert second["name"] == "电商视觉包 (2)" and second["replaced"] is False


def test_replacing_a_package_with_one_md_file_clears_its_folder(client, tmp_path):
    root = make_package(tmp_path / "pack")
    first = only_imported(import_paths(client, root))
    folder = Path(first["package_dir"])
    assert folder.exists()
    result = client.post("/api/prompt-skills/import", json={
        "filename": "SKILL.md", "on_conflict": "replace",
        "content": "---\nname: 电商视觉包\n---\n\n# 电商视觉包\n\n就一句话。"})
    after = only_imported(result)
    assert after["id"] == first["id"] and after["source"] == "md"
    assert after["package_dir"] is None and after["package"] is None
    assert not folder.exists(), "换成一枚孤立的 md，上一版的包不该留在盘上"


def test_builtin_skills_are_never_a_replacement_target(client, tmp_path):
    # 内置那条也叫「图片通用优化」这类名字很正常：把它当成「该被替换的旧版本」
    # 会直接把出厂写法吃掉，而那条是删不掉的，用户连还原都找不回
    bid = builtin_id(client, "image_default")
    client.patch("/api/prompt-skills/" + str(bid), json={"name": "电商视觉包"})
    before = next(row for row in client.get("/api/prompt-skills").json() if row["id"] == bid)
    root = make_package(tmp_path / "pack")
    data = import_paths(client, root).json()
    assert data["conflicts"] == [], data
    assert len(data["imported"]) == 1
    assert data["imported"][0]["id"] != bid, "不许把新包挂到内置那条上"
    after = next(row for row in client.get("/api/prompt-skills").json() if row["id"] == bid)
    assert after["source"] == before["source"] == "manual", "内置那条不许被改成导入来源"
    assert after["instruction"] == before["instruction"], "出厂写法一个字都不许动"


def test_unknown_conflict_mode_is_refused(client, tmp_path):
    root = make_package(tmp_path / "pack")
    assert import_paths(client, root, on_conflict="覆盖").status_code == 422


# ---------- 内置的两条「按模型改写」技能：写法随包走，H3 那份还带着官方指南 ----------


def seed_of(key):
    return next(seed for seed in service.BUILTINS if seed["builtin_key"] == key)


def builtin_row(client, key):
    return next(item for item in client.get("/api/prompt-skills").json() if item["builtin_key"] == key)


def test_builtin_qwen_is_a_plain_skill_with_no_package(client):
    row = builtin_row(client, "qwen_image")
    assert row["source"] == "manual" and row["package"] is None and row["package_dir"] is None


def test_builtin_h3_ships_the_reference_guides_it_promises(client):
    row = builtin_row(client, "h3_image")
    # 正文那一节写着「下面附的是 MiniMax 官方两份提示词指南原文」：资料就得真的跟着走。
    # 只带正文不带资料，模型以为后面有东西、却什么也没看见，这种缺法在界面上看不出来。
    assert "官方两份提示词指南" in row["instruction"]
    assert row["source"] == "package"
    # 随包的东西在安装包里，不在数据目录里再长一份能被人改掉的副本
    assert row["package_dir"] is None
    files = row["package"]["files"]
    assert [item["path"] for item in files] == ["SKILL.md", "references/edit-en.txt", "references/t2i-en.txt"]
    assert [item["role"] for item in files] == ["写法", "参考", "参考"]
    assert [item["included"] for item in files] == [False, True, True]
    assert row["package"]["dropped"] == []


def test_builtin_h3_references_are_all_there_and_none_is_cut():
    payload = bundled_skills.h3_package_payload()
    # 一个字都没被参考预算挤掉：挤掉就是界面上少一份资料、模型少读一截，很难查
    assert payload["refs_chars"] == sum(len(text) for _, text in bundled_skills.H3_PACKAGE_REFS)
    refs = [item for item in payload["files_meta"] if item["path"] != "SKILL.md"]
    assert len(refs) == 2 and all(item["included"] and not item["truncated"] for item in refs)


def test_builtin_h3_row_is_the_shipped_text_byte_for_byte(init_db, client):
    row = init_db.main().execute(
        "SELECT instruction,package_refs FROM prompt_skills WHERE builtin_key='h3_image'").fetchone()
    assert row["instruction"] == bundled_skills.H3_IMAGE_INSTRUCTION
    assert row["package_refs"] == bundled_skills.h3_package_payload()["block"]


def test_builtin_h3_references_reach_the_model_after_the_body(init_db, client):
    sid = builtin_id(client, "h3_image")
    # 取库里的整行：public() 那份是给界面的，不带资料块正文
    row = init_db.main().execute("SELECT * FROM prompt_skills WHERE id=?", (sid,)).fetchone()
    prompt = service.system_prompt(row)
    assert "--- references/edit-en.txt ---" in prompt and "--- references/t2i-en.txt ---" in prompt
    # 顺序：正文在前、资料在中、谁都不许违反的硬规矩垫底
    assert prompt.index("MiniMax") < prompt.index("--- references/edit-en.txt ---")
    assert prompt.index("只返回优化后的提示词正文") > prompt.index("--- references/t2i-en.txt ---")


# ---------- 第五条内置：闪寻视频生成H3优化 ----------
#
# 这条和 H3-Image 那条的区别只在「正文与资料从哪来」：H3-Image 四段内联在 bundled_skills
# 里，这条是随包数据目录（backend/app/bundled_skill_packages/h3-video/）。装进库之后的形状
# 必须完全一样，界面上、发请求时都不该看出差别。


def test_ref_budget_is_pinned_wide_enough_for_the_shipped_video_skill():
    # 参考预算从 20000 抬到 60000 是为了装下这条技能的四份资料。钉住数值本身：
    # 谁哪天把它调回去，四份里按路径排在后面的两份会整份消失，而界面上看不出来。
    assert skill_packages.MAX_REFS_CHARS == 60_000
    payload = bundled_skills.h3_video_package_payload()
    refs = [item for item in payload["files_meta"] if item["path"] != "SKILL.md"]
    assert len(refs) == 4 and all(item["included"] and not item["truncated"] for item in refs)
    assert payload["refs_chars"] == sum(len(item["text"]) for item in payload["entries"][1:])
    assert payload["refs_chars"] < skill_packages.MAX_REFS_CHARS


def test_builtin_h3_video_ships_the_craft_references_it_promises(client):
    row = builtin_row(client, "h3_video")
    # 正文末尾点名了四份资料的路径，那这四份就得真的跟着走
    body = row["instruction"]
    for path in ("references/combat-beats.md", "references/combat-moves.md",
                 "references/combat-impact.md", "references/camera-spec.md"):
        assert path in body, path
    assert row["source"] == "package"
    assert row["package_dir"] is None
    files = row["package"]["files"]
    assert [item["path"] for item in files] == [
        "SKILL.md", "references/camera-spec.md", "references/combat-beats.md",
        "references/combat-impact.md", "references/combat-moves.md"]
    assert [item["role"] for item in files] == ["写法", "参考", "参考", "参考", "参考"]
    assert [item["included"] for item in files] == [False, True, True, True, True]
    assert row["package"]["dropped"] == []


def test_builtin_h3_video_row_is_the_shipped_files_byte_for_byte(init_db, client):
    row = init_db.main().execute(
        "SELECT instruction,package_refs FROM prompt_skills WHERE builtin_key='h3_video'").fetchone()
    assert row["instruction"] == bundled_skills.h3_video_instruction()
    assert row["package_refs"] == bundled_skills.h3_video_package_payload()["block"]


def test_builtin_h3_video_references_reach_the_model_after_the_body(init_db, client):
    sid = builtin_id(client, "h3_video")
    row = init_db.main().execute("SELECT * FROM prompt_skills WHERE id=?", (sid,)).fetchone()
    prompt = service.system_prompt(row)
    assert "--- references/camera-spec.md ---" in prompt
    assert "--- references/combat-moves.md ---" in prompt
    # 顺序：正文在前、资料在中、谁都不许违反的硬规矩垫底
    assert prompt.index("六段") < prompt.index("--- references/camera-spec.md ---")
    assert prompt.index("只返回优化后的提示词正文") > prompt.index("--- references/combat-moves.md ---")


def test_builtin_h3_video_writes_english_prose_but_keeps_chinese_dialogue(client):
    row = builtin_row(client, "h3_video")
    # 六段协议的段名、参考标签、台词的语言标签都必须是英文，所以出厂语言规矩是 en
    assert row["language"] == "en"
    # 但台词本身不翻译，这条得在正文里说明白，光靠「Output in English」会被理解成连台词也译
    assert "[Chinese]" in row["instruction"]
    assert "不翻译" in row["instruction"] or "一字" in row["instruction"]
    assert "Output in English." in service.system_prompt(row)


def test_restore_default_goes_back_to_that_builtin_language_not_auto(client):
    sid = builtin_id(client, "h3_video")
    client.patch(f"/api/prompt-skills/{sid}", json={"language": "zh", "instruction": "我自己那份"})
    restored = client.post(f"/api/prompt-skills/{sid}/restore-default").json()
    # 恢复默认恢复的是这条技能自己的默认。硬写 auto 会把 en 这个出厂值恢复没了
    assert restored["language"] == "en"
    assert restored["instruction"] == bundled_skills.h3_video_instruction()


def test_the_sidecar_spec_ships_the_video_skill_package():
    """打包口径：这条技能的正文与资料必须随 sidecar 一起进安装包。

    漏了这一条，开发期一切正常（直接读仓库里的目录），发出去的包里却没有这条技能，
    而界面上只留下「少了个技能」——没人会怀疑到 spec 头上。钉在 spec 文本上最便宜。
    """
    spec = Path(__file__).resolve().parents[2] / "frontend" / "pyinstaller" / "python-backend.spec"
    text = spec.read_text(encoding="utf-8")
    assert 'BACKEND_DIR / "app" / "bundled_skill_packages"' in text
    assert '"app/bundled_skill_packages"' in text
    # 而且真的进了 Analysis 的 datas，不是只声明一个没人用的变量
    assert "datas=BUNDLE_DATAS" in text


def test_a_missing_package_dir_skips_the_video_builtin_instead_of_shipping_an_empty_one(
        init_db, client, monkeypatch, tmp_path):
    """资源没打进包时宁可少一条技能，也不装一条「正文说后面有资料、其实一份都没附」的。

    patch 的是「资源目录在哪」这一步，不是 available 本身：BUILTINS 里存的是 available 的函数
    引用，patch 模块上那个同名属性动不到已经存下来的那一份，而 available 每次都是现场去问目录。
    """
    conn = init_db.main()
    conn.execute("DELETE FROM prompt_skills WHERE builtin_key='h3_video'")
    monkeypatch.setattr(bundled_skills, "h3_video_dir", lambda: tmp_path / "not-shipped")
    service.initialize(conn)
    keys = [row["builtin_key"] for row in client.get("/api/prompt-skills").json()]
    assert "h3_video" not in keys
    assert "h3_image" in keys, "只跳过缺资源那一条，别把别的内置一起带走"


# ---------- 界面上选定的旋钮怎么送进模型 ----------


def test_optimize_puts_the_selected_knobs_before_the_output_rule(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "h3_video")
    knobs = "戏种：武戏｜武打速度：4档｜时长：8秒｜比例：9:16"
    result = optimize(client, sid, prompt="两个在天台上对打的人", kind="video", send_context=knobs)
    assert result.status_code == 200, result.text
    instruction = capture.calls[0]["instruction"]
    assert knobs in instruction
    # 它是写提示词的依据，得排在垫底的硬规矩之前；垫到最底会被前面那三万字挤到看不见。
    # 锚点用 OUTPUT_RULE 独有的那句：「输出要求」这四个字技能正文自己也会提到，不当锚点
    assert instruction.index(knobs) < instruction.index("只返回优化后的提示词正文")
    # 也必须排在参考资料之后：先读规矩，再读这次选了什么
    assert instruction.index("--- references/camera-spec.md ---") < instruction.index(knobs)


def test_a_run_with_no_reference_images_bans_inventing_reference_marks(client, model, monkeypatch):
    """一张参考都没发时，系统提示里得有一句明说「这次没有参考素材」。

    真机撞出来的：随包那条 H3 视频技能在 refs 为空时，模型照正文里满是 <Picture N> 的
    格式范例凭空造出 <Picture 1>..<Picture 3>，交回去的提示词指向三张不存在的图。
    正文第 3 条写了「不许自己编号」，八千字里的一条规矩拦不住，得有一句说得晚的。
    """
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "h3_video")
    assert optimize(client, sid, prompt="天台上两个人对打", kind="video").status_code == 200
    instruction = capture.calls[0]["instruction"]
    assert "这次没有把任何参考素材发给模型" in instruction
    # 说得晚才算数：得排在技能正文和四份资料之后，紧挨着垫底的输出规矩
    assert instruction.index("--- references/combat-moves.md ---") < instruction.index("这次没有把任何参考素材")
    assert instruction.index("这次没有把任何参考素材") < instruction.index("只返回优化后的提示词正文")


def test_the_no_reference_note_protects_marks_the_user_wrote_himself(client, model, monkeypatch):
    """那句提醒只能禁「新增」，不能禁「出现」。

    用户手打了 @图片1 又关掉「一起发参考」是真会发生的：那句 @图片1 在真提交时是有图的，
    模型要是照「不许有编号」把它删了，参考就静默失效——那是比措辞难看得多的坏事。
    """
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "h3_video")
    optimize(client, sid, prompt="照 <Picture 1> 拍两个人对打", kind="video")
    note = capture.calls[0]["instruction"]
    line = note[note.index("参考素材范围"):]
    assert "照原样保留" in line and "一个都不许删" in line
    assert "原文里没有的编号" in line


def test_sending_reference_images_does_not_claim_there_are_none(client, model, init_db, tmp_path,
                                                                monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "h3_video")
    image_id = make_image(init_db, tmp_path, "ref.png")
    result = optimize(client, sid, prompt="照 <Picture 1> 拍", kind="video",
                      refs=[{"ordinal": 1, "image_id": image_id}])
    assert result.status_code == 200, result.text
    instruction = capture.calls[0]["instruction"]
    # 真发了图却说「没有参考素材」是谎报，模型会开始删用户自己写的编号
    assert "这次没有把任何参考素材发给模型" not in instruction
    # 参考素材那句说明在 content 那一侧（图就挂在那儿），别到 system 里找
    texts = [part["text"] for part in capture.calls[0]["content"] if part["type"] == "text"]
    assert any("参考素材按编号依次附在下面" in text for text in texts)


def test_the_knob_block_is_named_the_way_the_shipped_skill_calls_it():
    """送出去那一段的标题，必须是技能正文用来指它的那三个字。

    技能正文有三处按「界面参数」这个名字去找这一段。标题单方面换成别的说法，模型多半还
    连得上，但那是靠语感而不是靠对得上；这一句读不到，前端拼的那行就白送。两边钉在一起。
    """
    assert "界面参数" in service.CONTEXT_NOTE
    body = (bundled_skills.h3_video_dir() / "SKILL.md").read_text(encoding="utf-8")
    assert body.count("界面参数") >= 3, "技能正文要是改口了，上面那句标题得跟着改"


def test_the_cut_verb_check_lists_the_five_verbs_inline():
    """自查表那条切点检查必须把五个动词原文摆在自己这一行上。

    真机三枪里有一枪把切点写成 `the camera pushes in ... from the full desk to a medium
    close-up`——一句运镜顶在切点上，模型就一路推下去不切了。正文第 2 节确实列过这五个动词，
    但交稿前那一眼看的是第 8 节，回头找名单找不着就照「把镜头怎么动写清楚」的语感走。
    名单钉在自查那一行上，不靠回指。
    """
    body = bundled_skills.h3_video_instruction()
    head = "## 8 交出去前自查"
    assert head in body, "自查那一节改了名，下面这些断言会全部落空"
    checklist = body.split(head, 1)[1].split("\n## ", 1)[0]
    for verb in ("the camera cuts to", "the shot cuts to", "the shot transitions to",
                 "the shot changes to", "the shot switches to"):
        assert verb in checklist, verb
    # 必须在这一节里数得出来：发版那份正文第 1、2 节各有一处 `the camera cuts to`，
    # 拿全文命中次数当凭据的话，自查表整条删掉都照样绿。


def test_the_check_list_says_subjects_stay_empty_without_references():
    """没挂参考时 `subject_definitions` 整段留空：底线那条写了，自查表也得有一条对得上。

    真机文戏那一枪三份参考都没挂，模型照样填了三条 `<Subject N>`。底线在第 0 节，交稿前
    扫的是第 8 节——同一件事在两处都得读得到，光靠第 0 节那次「优先级最高」不够。
    """
    body = bundled_skills.h3_video_instruction()
    hits = [line for line in body.splitlines() if "subject_definitions" in line and "留空" in line]
    assert len(hits) >= 2, "第 0 节那条 + 第 8 节那条，少一条就是又只剩一次提醒"
    assert any("一份参考都没挂" in line for line in hits), "自查那条要按弹窗上的实际情况说话"


def test_the_reference_note_stops_promising_four_files_on_every_run():
    """文戏那次只带 camera-spec，正文不许再说「下面附了四份资料」。

    上一轮做了按戏种筛资料，这句就成了假话：模型照着它以为手里有打斗资料，而界面小条上
    刚对用户说过那三份没带。改成教模型自己认——这次真带上的是哪几份，看分隔线。
    """
    body = bundled_skills.h3_video_instruction()
    assert "附了四份资料" not in body
    assert "--- references/xxx.md ---" in body, "得教它按分隔线认这次带来的资料"
    assert any("camera-spec.md" in line and "文戏" in line for line in body.splitlines()
               if "只有" in line), "只有 camera-spec 那一种情况要挑明是文戏"

def test_optimize_without_context_sends_no_knob_block(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "video_default")
    assert optimize(client, sid, prompt="两个在天台上对打的人", kind="video").status_code == 200
    # 没选就别硬塞一行空标题：模型会开始猜「戏种」是什么
    assert "选定的参数" not in capture.calls[0]["instruction"]


def test_optimize_sends_the_ordinary_skill_path_unchanged_when_context_is_blank(client, model,
                                                                                monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    sid = builtin_id(client, "image_default")
    optimize(client, sid, send_context="")
    blank = capture.calls[0]["instruction"]
    capture.calls.clear()
    optimize(client, sid)
    assert capture.calls[0]["instruction"] == blank


def test_optimize_refuses_an_oversized_knob_line(client, model, monkeypatch):
    monkeypatch.setattr(reverse_prompts, "request_model", Capture())
    sid = builtin_id(client, "video_default")
    # 前端负责压到 500 以内；真超了就是 422，不能让它悄悄拼进系统提示
    assert optimize(client, sid, kind="video", send_context="参" * 501).status_code == 422



def test_a_same_name_skill_is_adopted_instead_of_duplicated(init_db, client):
    conn = init_db.main()
    # 还原成「装内置之前」的库：只有他自己那一条同名的，身上没有 builtin_key
    conn.execute("DELETE FROM prompt_skills WHERE builtin_key='qwen_image'")
    mine = client.post("/api/prompt-skills", json={
        "name": "Qwen-Image-2.1 优化", "note": service.IMPORT_NOTE_PLACEHOLDER,
        "instruction": "我自己那份 Qwen 写法", "kinds": ["image"]}).json()
    service.initialize(conn)
    hits = [item for item in client.get("/api/prompt-skills").json() if item["name"] == "Qwen-Image-2.1 优化"]
    assert [item["id"] for item in hits] == [mine["id"]], "认领那一条，不再造一条重名的"
    assert hits[0]["builtin_key"] == "qwen_image"
    assert hits[0]["instruction"] == "我自己那份 Qwen 写法", "认领只挂身份，不改内容"
    # 还挂着导入时那句占位说明的，换成内置这一句
    assert hits[0]["note"] == seed_of("qwen_image")["note"]
    assert client.delete("/api/prompt-skills/" + str(mine["id"])).status_code == 409


def test_an_adopted_skill_keeps_its_own_note_and_gets_no_references(init_db, client):
    conn = init_db.main()
    conn.execute("DELETE FROM prompt_skills WHERE builtin_key='h3_image'")
    mine = client.post("/api/prompt-skills", json={
        "name": "H3-Image 优化", "note": "我自己写的说明", "instruction": "我自己那份 H3 写法"}).json()
    service.initialize(conn)
    row = next(item for item in client.get("/api/prompt-skills").json() if item["id"] == mine["id"])
    assert row["builtin_key"] == "h3_image"
    assert row["note"] == "我自己写的说明", "他自己写过的说明一个字不动"
    # 他那条本来不是技能包：内置的一万九千多字资料不许悄悄挂上去，那是每次优化都要多送的钱
    assert row["source"] == "manual" and row["package"] is None


def test_two_skills_with_the_same_name_are_left_alone(init_db, client):
    conn = init_db.main()
    conn.execute("DELETE FROM prompt_skills WHERE builtin_key='h3_image'")
    first = client.post("/api/prompt-skills", json={"name": "H3-Image 优化", "instruction": "甲"}).json()
    second = client.post("/api/prompt-skills", json={"name": "H3-Image 优化", "instruction": "乙"}).json()
    service.initialize(conn)
    names = [item for item in client.get("/api/prompt-skills").json() if item["name"] == "H3-Image 优化"]
    assert [item["id"] for item in names] == [first["id"], second["id"]]
    assert all(item["builtin_key"] is None for item in names), "同名有好几条时不替人挑哪条才是"


# ---------- 内置改过名：老库跟着换，他自己改过的一个字不碰 ----------


def test_a_legacy_named_builtin_is_renamed_on_start(init_db, client):
    conn = init_db.main()
    skill_id = builtin_id(client, "image_default")
    client.patch(f"/api/prompt-skills/{skill_id}", json={"instruction": "我自己那条的写法"})
    # 升级前的样子：那条内置身上挂的还是旧名
    conn.execute("UPDATE prompt_skills SET name='图片提示词增强' WHERE id=?", (skill_id,))
    service.initialize(conn)
    row = builtin_row(client, "image_default")
    assert row["name"] == "图片通用优化", "旧名是我们自己起的名，顺着改成现在这个"
    assert row["instruction"] == "我自己那条的写法", "改名只改名，写法是他的东西"


def test_a_user_renamed_builtin_is_left_alone(init_db, client):
    conn = init_db.main()
    skill_id = builtin_id(client, "video_default")
    # 名字既不是新名也不是旧名：那是他自己起的，不在「我们改过名」的范围里
    client.patch(f"/api/prompt-skills/{skill_id}", json={"name": "我的视频写法"})
    service.initialize(conn)
    assert builtin_row(client, "video_default")["name"] == "我的视频写法"


def test_a_legacy_named_skill_is_adopted_and_renamed(init_db, client):
    conn = init_db.main()
    conn.execute("DELETE FROM prompt_skills WHERE builtin_key='video_default'")
    mine = client.post("/api/prompt-skills", json={
        "name": "视频提示词增强", "instruction": "我自己那份视频写法"}).json()
    service.initialize(conn)
    hits = [item for item in client.get("/api/prompt-skills").json() if item["name"] == "视频通用优化"]
    assert [item["id"] for item in hits] == [mine["id"]], "叫旧名的那条认下来当内置、跟着改名，不再造一条重名的"
    assert hits[0]["builtin_key"] == "video_default"
    assert hits[0]["instruction"] == "我自己那份视频写法", "认领只挂身份，不改内容"


def test_the_rename_is_skipped_when_the_new_name_is_taken(init_db, client):
    conn = init_db.main()
    skill_id = builtin_id(client, "image_default")
    other = client.post("/api/prompt-skills", json={"name": "图片通用优化", "instruction": "别人占的名"}).json()
    conn.execute("UPDATE prompt_skills SET name='图片提示词增强' WHERE id=?", (skill_id,))
    service.initialize(conn)
    assert builtin_row(client, "image_default")["name"] == "图片提示词增强", "改完就是两条同名，宁可不改"
    taken = [item for item in client.get("/api/prompt-skills").json() if item["name"] == "图片通用优化"]
    assert [item["id"] for item in taken] == [other["id"]]


def test_restore_default_brings_back_the_current_name(client):
    skill_id = builtin_id(client, "image_default")
    client.patch(f"/api/prompt-skills/{skill_id}", json={"name": "随便改的名"})
    restored = client.post(f"/api/prompt-skills/{skill_id}/restore-default").json()
    assert restored["name"] == "图片通用优化"


def test_a_half_written_builtin_package_gets_its_refs_back(init_db, client):
    skill_id = builtin_id(client, "h3_image")
    # 装到一半断电的样子：清单写进去了，资料块还是空的
    init_db.main().execute("UPDATE prompt_skills SET package_refs=NULL WHERE id=?", (skill_id,))
    service.initialize(init_db.main())
    assert init_db.main().execute(
        "SELECT package_refs FROM prompt_skills WHERE id=?", (skill_id,)).fetchone()[0]


def test_restoring_a_builtin_keeps_its_references(client, init_db):
    skill_id = builtin_id(client, "h3_image")
    client.patch("/api/prompt-skills/" + str(skill_id), json={"instruction": "换成我自己的短写法"})
    restored = client.post("/api/prompt-skills/" + str(skill_id) + "/restore-default").json()
    assert restored["instruction"] == bundled_skills.H3_IMAGE_INSTRUCTION
    refs = init_db.main().execute("SELECT package_refs FROM prompt_skills WHERE id=?", (skill_id,)).fetchone()[0]
    assert refs and "--- references/t2i-en.txt ---" in refs, "恢复的是写法，资料一个字不动"


# ---------- 包目录被人在文件夹里删掉：直接从清单里消失，不弹提示 ----------


def test_skill_whose_package_folder_was_deleted_disappears_from_the_list(client, tmp_path):
    # 2026-11-17 苏醒：「当我在文件夹中删除这个 skill，不需要提示，直接删除显示即可。」
    root = make_package(tmp_path / "pack")
    imported = only_imported(import_paths(client, root))
    folder = Path(imported["package_dir"])
    assert folder.exists()
    shutil.rmtree(folder)
    rows = client.get("/api/prompt-skills").json()
    assert imported["id"] not in [row["id"] for row in rows], (
        "文件夹删了就是在删这条技能，清单里不该还摆着它")
    # 库里那一行是真没了，写法留一份副本到 skills/_removed/，删错了人自己能捡回来
    kept = list((service.skills_dir() / "_removed").glob(f"{imported['id']}-*.md"))
    assert len(kept) == 1, kept
    assert "先定光，再定镜头。" in kept[0].read_text(encoding="utf-8")


def test_list_keeps_every_skill_whose_folder_is_still_there(client, tmp_path):
    root = make_package(tmp_path / "pack")
    imported = only_imported(import_paths(client, root))
    before = client.get("/api/prompt-skills").json()
    after = client.get("/api/prompt-skills").json()
    assert [row["id"] for row in before] == [row["id"] for row in after], "拉两次清单不该少东西"
    assert next(r for r in after if r["id"] == imported["id"])["package_dir"]


def test_a_skill_root_that_is_not_readable_is_not_treated_as_deleted(client, tmp_path, monkeypatch):
    # 盘没挂上（U 盘没插、数据目录在网盘还没落下来）和「他真删了」长得一样：分不清就一条都不动
    root = make_package(tmp_path / "pack")
    imported = only_imported(import_paths(client, root))
    monkeypatch.setattr(service, "data_dir", lambda: tmp_path / "usb-drive-not-mounted")
    rows = client.get("/api/prompt-skills").json()
    assert imported["id"] in [row["id"] for row in rows], "读不到 skills 根目录时不许删任何东西"


def test_builtin_with_a_missing_folder_only_loses_that_path(client, init_db, tmp_path):
    service.skills_dir()  # 让 skills 根目录先存在，否则这一趟本来就该整趟跳过
    bid = builtin_id(client, "qwen_image")
    gone = str(service.skills_dir() / "999")  # 一个不存在的路径：他把它删了
    init_db.main().execute("UPDATE prompt_skills SET package_dir=? WHERE id=?", (gone, bid))
    stamped = init_db.main().execute("SELECT package_dir FROM prompt_skills WHERE id=?",
                                     (bid,)).fetchone()[0]
    assert stamped == gone, "先确认路径真的挂上去了，否则这条测不到东西"
    # 第一次拉清单就会走一遍清理，所以「抹掉之前是什么」只能从库里取
    row = next(r for r in client.get("/api/prompt-skills").json() if r["id"] == bid)
    assert row["package_dir"] is None, "内置那条只抹掉失效路径，「在文件夹中显示」跟着消失"
    assert row["builtin_key"] == "qwen_image", "内置那条不许被一起删掉（它本来就删不掉）"
    assert row["instruction"] == service.builtin_seed("qwen_image")["instruction"], (
        "内置那条的写法一个字都不许动")


def test_pruned_skill_clears_the_default_pointer(client, tmp_path):
    root = make_package(tmp_path / "pack")
    imported = only_imported(import_paths(client, root))
    client.put("/api/prompt-skill-settings",
               json={"default_image_skill": imported["id"], "default_video_skill": None})
    assert client.get("/api/prompt-skill-settings").json()["default_image_skill"] == imported["id"]
    shutil.rmtree(Path(imported["package_dir"]))
    rows = client.get("/api/prompt-skills").json()
    assert imported["id"] not in [row["id"] for row in rows]
    assert client.get("/api/prompt-skill-settings").json()["default_image_skill"] is None, (
        "技能没了，默认指针不能还指着它（外键 ON DELETE SET NULL）")


# ---------- 戏种开关决定这一次带哪几份资料 ----------

def all_package_refs() -> dict[str, str]:
    """随包那条 H3 视频技能的每份附属资料原文。库里那份就是拿这些拼的（同一进程同源）。"""
    return {item["path"]: item["text"] for item in bundled_skills.h3_video_package_entries()
            if item["path"] != bundled_skills.H3_VIDEO_SKILL_PATH}


def combat_probes() -> dict[str, str]:
    """每份武戏资料里截一小段正文当探针。

    只断言「分隔线不在了」不够——分隔线是拼装的壳，正文才是真发给模型的东西。
    截中段是避开开头那几行标题与 frontmatter，那里可能只有路径名本身。
    """
    return {path: text[500:560] for path, text in all_package_refs().items()
            if bundled_skills.is_h3_video_combat_ref(path)}


def test_the_prefix_rule_catches_exactly_the_combat_files():
    """前缀那条规矩认出来的就是这三份。

    以后往 references/ 里加第四份 combat-*，它会跟着进名单，这条会红——那是提醒
    「你加了一份新的武戏资料，记得确认文戏确实不该带它」，不是拦路。反过来，谁改了
    文件名让前缀认不出，这条同样红：那时文戏又开始白背它，正是这一轮要修的事。
    """
    assert sorted(combat_probes()) == [
        "references/combat-beats.md", "references/combat-impact.md", "references/combat-moves.md"]
    assert "references/camera-spec.md" not in combat_probes(), "镜头规格文戏也要用，不许算进武戏"


def test_drama_request_sends_no_combat_reference(client, model, init_db, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    skill_id = builtin_id(client, "h3_video")
    drama = optimize(client, skill_id, prompt="苏晚在深夜的巷口等车", kind="video", send_scene="drama")
    combat = optimize(client, skill_id, prompt="苏晚在深夜的巷口等车", kind="video", send_scene="combat")
    assert drama.status_code == 200, drama.text
    sent = capture.calls[0]["instruction"]
    full = capture.calls[1]["instruction"]
    for path, probe in combat_probes().items():
        assert probe not in sent, path + " 的正文还是发出去了"
    # 逐字核账：少掉的字数必须正好等于那三份的字数加上它们各自的分隔线，一个字都不许多少。
    # 不拿「路径名不许出现在 system 里」当判据——技能正文自己就点名了这三份在哪，
    # 那三行是该在的，被切掉的只有资料本身。
    missing = sum(len(text) + len(skill_packages.refs_separator(path))
                  for path, text in all_package_refs().items()
                  if bundled_skills.is_h3_video_combat_ref(path))
    assert len(full) - len(sent) == missing, (len(full), len(sent), missing)
    # 镜头规格不是武戏专用，文戏同样要它，不许被连坐删掉
    assert "references/camera-spec.md" in sent
    assert full.split("技能包参考资料")[0] == sent.split("技能包参考资料")[0], (
        "正文与那四份之外的部分必须逐字相等：筛只发生在资料块这一层")
    omitted = drama.json()["omitted_refs"]
    assert combat.json()["omitted_refs"] is None
    assert sorted(omitted["paths"]) == sorted(combat_probes())
    assert "文戏" in omitted["reason"] and "预算" not in omitted["reason"], (
        "丢了要看得见，而且说的得是真原因，不能蹭「超出参考预算」那句")


def test_combat_request_sends_every_reference_it_always_sent(client, model, init_db, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    skill_id = builtin_id(client, "h3_video")
    result = optimize(client, skill_id, prompt="苏晚在巷口拔刀", kind="video", send_scene="combat")
    assert result.status_code == 200, result.text
    sent = capture.calls[0]["instruction"]
    for path, text in all_package_refs().items():
        assert text[500:560] in sent, path + " 该在的，武戏全带"
    assert result.json()["omitted_refs"] is None


def test_unknown_scene_carries_the_package_exactly_as_before(client, model, init_db, monkeypatch):
    """不送这个字段、送空串、送一个认不出的值：三种「不知道」都和改动之前一模一样。

    判据不是「也带了三份」，是拼出去的整条 system 逐字相等——连顺序、壳、字数都不许变。
    """
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    skill_id = builtin_id(client, "h3_video")
    optimize(client, skill_id, prompt="苏晚", kind="video")
    whole = capture.calls[0]["instruction"]
    for blind in ("", "武戏", "COMBAT", "anything-else"):
        optimize(client, skill_id, prompt="苏晚", kind="video", send_scene=blind)
        assert capture.calls[-1]["instruction"] == whole, "不知道戏种时不许改内容: " + repr(blind)
    # 而明确报了武戏的那一次，也和不报的逐字相等（武戏本来就该全带）
    optimize(client, skill_id, prompt="苏晚", kind="video", send_scene="combat")
    assert capture.calls[-1]["instruction"] == whole


def test_other_skills_are_not_touched_by_the_scene_switch(client, model, init_db, monkeypatch):
    """本轮只动认戏种的那一条。其他技能包的资料照旧整份塞，行为一个字不许变。"""
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    skill_id = builtin_id(client, "h3_image")
    optimize(client, skill_id, prompt="一只猫", kind="image")
    whole = capture.calls[0]["instruction"]
    optimize(client, skill_id, prompt="一只猫", kind="image", send_scene="drama")
    assert capture.calls[0]["instruction"] == capture.calls[1]["instruction"]
    assert capture.calls[1]["instruction"] == whole
    assert client.post(f"/api/prompt-skills/{skill_id}/optimize",
                       json={"prompt": "一只猫", "kind": "image", "refs": [],
                             "scene_type": "drama"}).json()["omitted_refs"] is None


# ---------- 切资料块那颗函数自己 ----------

def test_filtering_a_refs_block_round_trips_when_nothing_is_dropped():
    paths = ["references/a.md", "references/b.md"]
    block, meta, _ = skill_packages.compose_refs_block(
        [{"path": "SKILL.md", "text": "正文", "size": 6, "is_text": True},
         {"path": paths[0], "text": "第一份", "size": 9, "is_text": True},
         {"path": paths[1], "text": "第二份", "size": 9, "is_text": True}],
        "正文", "SKILL.md")
    assert [item["path"] for item in meta if item["included"]] == paths
    kept, dropped = skill_packages.filter_refs_block(block, paths, set())
    assert dropped == [] and kept == block, "什么都不摘时必须逐字原样，拼回去的那颗不能改格式"
    cut, dropped = skill_packages.filter_refs_block(block, paths, {paths[0]})
    assert dropped == [paths[0]]
    assert "第一份" not in cut and "第二份" in cut
    # 留下的那一段必须连自己那行分隔线一起留下：只截正文会让清单和块各说各话
    assert skill_packages.refs_separator(paths[1]) in cut
    # 少掉的正好是「那一段的分隔线 + 它的正文」，一分不多一分不少
    assert len(block) - len(cut) == len(skill_packages.refs_separator(paths[0])) + len("第一份")


def test_filtering_a_refs_block_refuses_when_the_table_does_not_match():
    """清单和块对不上时宁可整份带：切一半送进模型比多带几份坏得多。"""
    block, _, _ = skill_packages.compose_refs_block(
        [{"path": "SKILL.md", "text": "正文", "size": 6, "is_text": True},
         {"path": "references/a.md", "text": "第一份", "size": 9, "is_text": True}],
        "正文", "SKILL.md")
    assert skill_packages.filter_refs_block(block, ["references/nope.md"], {"references/nope.md"}) is None
    assert skill_packages.filter_refs_block("没有标题的一块东西", ["references/a.md"],
                                            {"references/a.md"}) is None
    assert skill_packages.filter_refs_block("", [], set()) == ("", [])


def test_dropping_every_reference_leaves_no_dangling_header():
    """全摘完要连那句「技能包参考资料」的标题一起没，否则模型看到一句指向空的话。"""
    block, _, _ = skill_packages.compose_refs_block(
        [{"path": "SKILL.md", "text": "正文", "size": 6, "is_text": True},
         {"path": "references/a.md", "text": "第一份", "size": 9, "is_text": True}],
        "正文", "SKILL.md")
    cut, dropped = skill_packages.filter_refs_block(block, ["references/a.md"], {"references/a.md"})
    assert dropped == ["references/a.md"] and cut == ""
