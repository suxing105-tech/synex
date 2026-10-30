# -*- coding: utf-8 -*-
"""拆分成三条之后，别让「拆分之前那次删除」永久吃掉参考音色。

现场证据（F:\\SeekX-Data\\db.sqlite 只读查出来的）：
meta.clone_bundled_templates_dismissed = ["qwen-multi-image-edit", "qwen3-tts-voice-clone"]
=> 0.2.31 的 seed 把新出现的 custom-voice / voice-design 装进去了，
   唯独把拉黑中的 qwen3-tts-voice-clone（参考音色）照单全拒。
"""
import io

APP = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/app/clone_bundled.py"
TESTS = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/tests/test_clone_bundled.py"

A1 = 'DISMISSED_META_KEY = "clone_bundled_templates_dismissed"\n'
B1 = A1 + '''# 0.2.31 把「闪寻音频」一条拆成参考音色 / 指定音色 / 音色描述三条。
# 只有被拆过的那条需要放行：图片、视频、以及拆完新增的两条，删了就是用户本意。
SPLIT_RESCUE_KEYS = ("qwen3-tts-voice-clone",)
'''

A2 = '''def cell_keys_of(template: dict) -> list[str]:'''
B2 = '''def forgive_split_keys(conn) -> list[str]:
    """抹掉「拆分之前那次删除」留下的拉黑记录，返回这次放行的是哪几条。

    老库里删掉的是一条叫「闪寻音频」的声音工作流，拉黑记的名字却是拆完之后
    其中一条的 key（qwen3-tts-voice-clone）。升级后 seed 照单全拒，三种出声方式
    凭空少一种、界面也不解释，用户只能以为打包漏了。那次删除不可能是拒绝
    「参考音色」——它当时还不存在。

    放行 = 直接把名字从名单里删掉，所以天然只发生一次：用户之后自己再删，
    note_dismissal 会重新记上，从此不再复活。代价是「升级前一天刚删过参考音色」
    的人会被放回一次，比让所有人少一种模式小得多。
    """
    gone = dismissed(conn)
    hit = set(SPLIT_RESCUE_KEYS)
    forgiven = sorted(gone & hit)
    if not forgiven:
        return []
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DISMISSED_META_KEY, json.dumps(sorted(gone - hit), ensure_ascii=False)),
    )
    logger.info("内置工作流放行：%s（拆分之前的删除不该吃掉新模式）", "、".join(forgiven))
    return forgiven


''' + A2

A3 = '''    summary = {"inserted": [], "updated": [], "adopted": [], "renamed": [],
               "skipped": [], "dismissed": []}
    if not seed_enabled():
        return summary
    gone = dismissed(conn)'''
B3 = '''    summary = {"inserted": [], "updated": [], "adopted": [], "renamed": [],
               "skipped": [], "dismissed": [], "rescued": []}
    if not seed_enabled():
        return summary
    summary["rescued"] = forgive_split_keys(conn)
    gone = dismissed(conn)'''

NEW_TESTS = """

def test_a_pre_split_deletion_does_not_swallow_a_mode(seeded):
    \"\"\"拆成三条之前删过老「闪寻音频」的库，升级后必须把「参考音色」还回来。\"\"\"
    conn = seeded.main()
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(target["id"])
    assert AUDIO_KEY in clone_bundled.dismissed(conn)
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert {r["bundled_key"] for r in clone_templates.list_templates()} == set(ALL_KEYS), "三种模式齐了"
    assert AUDIO_KEY not in clone_bundled.dismissed(conn), "放行要真把名字从名单里抹掉"


def test_the_rescue_happens_only_once(seeded):
    \"\"\"放行之后再删就是用户自己的决定，不许每次启动都复活一次。\"\"\"
    conn = seeded.main()
    first = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(first["id"])
    clone_bundled.seed(conn)
    back = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(back["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert AUDIO_KEY in again["dismissed"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_a_mode_that_was_never_split_is_never_rescued(seeded):
    \"\"\"图片那条没被拆过：删了就删了，不能被同一段逻辑捞回来。\"\"\"
    conn = seeded.main()
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY][0]
    clone_templates.delete_template(target["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY] == []


def test_rescuing_leaves_the_other_dismissals_alone(seeded):
    \"\"\"放行只动被拆过的那个 key，别的拉黑记录一个字都不许变。\"\"\"
    conn = seeded.main()
    for key in (AUDIO_KEY, DESIGN_KEY):
        row = [r for r in clone_templates.list_templates() if r["bundled_key"] == key][0]
        clone_templates.delete_template(row["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert clone_bundled.dismissed(conn) == {DESIGN_KEY}
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == DESIGN_KEY] == []
"""


def patch(path, pairs, append=None):
    t = io.open(path, encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in t[:2000] else "\n"
    pairs = [(a.replace("\n", nl), b.replace("\n", nl)) for a, b in pairs]
    for a, b in pairs:
        assert t.count(a) == 1, (path, a[:40], t.count(a))
        t = t.replace(a, b)
    if append:
        if not t.endswith(nl):
            t += nl
        t += append.replace("\n", nl)
    io.open(path, "w", encoding="utf-8", newline="").write(t)
    print("patched", path)


patch(APP, [(A1, B1), (A2, B2), (A3, B3)])
patch(TESTS, [], NEW_TESTS)