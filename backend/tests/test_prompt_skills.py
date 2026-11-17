"""提示词优化技能：种子自愈、增删改、导入、默认技能，以及一次优化的请求长什么样。

优化会真的打模型，所以一律打桩 reverse_prompts.request_model：断言的是「我们到底拼了
什么请求出去」——引用标记的规则、图的编号、输出形态。真发请求既花钱也测不到这些。
"""
from __future__ import annotations

from pathlib import Path
import zipfile

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

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
    # 内置那条也叫「图片提示词增强」这类名字很正常：把它当成「该被替换的旧版本」
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
