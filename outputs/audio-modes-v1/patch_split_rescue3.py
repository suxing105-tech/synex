# -*- coding: utf-8 -*-
"""新库在 initialize() 里就 seed 过一次，旗标已经落库了。

测试要演「升级上来的老库」，得先把旗标那一行抹掉——生产里老库跑的是没有这段逻辑的
旧版本，升级后第一次启动才轮到放行。这段坑值得写在测试里，别下一次又以为逻辑错了。
"""
import io

TESTS = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/tests/test_clone_bundled.py"
raw = io.open(TESTS, encoding="utf-8", newline="").read()
nl = "\r\n" if "\r\n" in raw else "\n"
start = raw.index("\n\ndef test_a_pre_split_deletion_does_not_swallow_a_mode(seeded):")
head = raw[:start]

BLOCK = '''

def _pretend_pre_split_install(pool) -> None:
    """把库演成「从旧版本升级上来的」：放行旗标还没落库。

    新库在 db.ConnectionPool.initialize() 里已经 seed 过一次，旗标当时就写上了；
    老库跑的旧版本根本没这段逻辑，升级后第一次启动才轮到放行。
    """
    pool.main().execute("DELETE FROM meta WHERE key=?", (clone_bundled.SPLIT_RESCUE_FLAG,))


def test_a_fresh_install_marks_the_flag_once(seeded):
    """新装库第一次装载就该落旗标，此后删参考音色是永久删。"""
    conn = seeded.main()
    assert conn.execute("SELECT 1 FROM meta WHERE key=?",
                        (clone_bundled.SPLIT_RESCUE_FLAG,)).fetchone() is not None
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(target["id"])
    assert clone_bundled.seed(conn)["rescued"] == []
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_a_pre_split_deletion_does_not_swallow_a_mode(seeded):
    """拆成三条之前删过老「闪寻音频」的库，升级后必须把「参考音色」还回来。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(target["id"])
    assert AUDIO_KEY in clone_bundled.dismissed(conn)
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert {r["bundled_key"] for r in clone_templates.list_templates()} == set(ALL_KEYS), "三种模式齐了"
    assert AUDIO_KEY not in clone_bundled.dismissed(conn), "放行要真把名字从名单里抹掉"


def test_the_rescue_happens_only_once(seeded):
    """放行之后再删就是用户自己的决定，不许每次启动都复活一次。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    first = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(first["id"])
    assert clone_bundled.seed(conn)["rescued"] == [AUDIO_KEY]
    back = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(back["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert AUDIO_KEY in again["dismissed"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_a_mode_that_was_never_split_is_never_rescued(seeded):
    """图片那条没被拆过：删了就删了，不能被同一段逻辑捞回来。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    target = [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY][0]
    clone_templates.delete_template(target["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == []
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == IMAGE_KEY] == []


def test_rescuing_leaves_the_other_dismissals_alone(seeded):
    """放行只动被拆过的那个 key，别的拉黑记录一个字都不许变。"""
    conn = seeded.main()
    _pretend_pre_split_install(seeded)
    for key in (AUDIO_KEY, DESIGN_KEY):
        row = [r for r in clone_templates.list_templates() if r["bundled_key"] == key][0]
        clone_templates.delete_template(row["id"])
    again = clone_bundled.seed(conn)
    assert again["rescued"] == [AUDIO_KEY]
    assert clone_bundled.dismissed(conn) == {DESIGN_KEY}
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == DESIGN_KEY] == []
'''
out = head + BLOCK.replace("\n", nl)
io.open(TESTS, "w", encoding="utf-8", newline="").write(out)
print("rewrote the new test block")