# -*- coding: utf-8 -*-
"""改两条测试：撞名时分两种情况，装载那条老路会「认领」同名旧记录，不是硬 409。

跑出来才发现的：删掉内置之后用户自己导过一份同名的，seed 走 _adoptable_row 认领它
（内容留用户的、bundled_key 挂上），这是既有的「不造重名」规矩，恢复不该另立一套。
真 409 只发生在名字被**别一条内置**占着的时候（改名成内置名的那条）。
"""
import io

BE = "C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/tests/test_clone_bundled.py"
t = io.open(BE, encoding="utf-8", newline="").read()
nl = "\r\n" if "\r\n" in t[:4000] else "\n"
start = t.index("def test_restore_is_409_when_the_name_is_taken(seeded):")
end = t.index("def test_restore_clears_a_key_the_package_no_longer_ships(seeded, monkeypatch):")
NEW = '''def test_restore_is_409_when_another_template_holds_the_name(seeded):
    """名字被**别一条**工作流占着（模板名有唯一索引）时装不进来：回 409 并说清下一步。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    other = [r for r in clone_templates.list_templates() if r["bundled_key"] == VIDEO_KEY][0]
    clone_templates.update_template(other["id"], {"name": "闪寻参考音色"})
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 409, res.text
        assert "改名" in res.json()["detail"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_restore_adopts_a_same_name_template_the_user_imported(seeded):
    """用户自己导过一份同名的 → 恢复走装载那条老路：认领这一条，不造重名的。

    内容是用户那份，bundled_sha 记的是随包指纹，两者不等就等于「他改过」，
    以后版本更新不会覆盖他。这条不是新规矩，和首次装载同一套。
    """
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    mine = clone_templates.create_template("闪寻参考音色", _fake_entry(label="闪寻参考音色")["workflow"])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 200, res.text
    after = clone_templates.get_template(int(mine["id"]))
    assert after["bundled_key"] == AUDIO_KEY and after["is_builtin"] is True
    assert clone_bundled.workflow_sha(after["workflow"]) != after["bundled_sha"], "内容仍是用户那份"
    assert clone_bundled.dismissed(seeded.main()) == set()


'''
t = t[:start] + NEW.replace("\n", nl) + t[end:]
io.open(BE, "w", encoding="utf-8", newline="").write(t)
print("rewrote the two collision tests")