# -*- coding: utf-8 -*-
"""第一版放行写错了：放行把名字从名单里抹掉，用户再删名字又回名单，下次启动再放行 = 无限复活。

这条是 test_the_rescue_happens_only_once 逼出来的（它先红了）。改成旗标落库，只放行一次。
"""
import io

APP = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/backend/app/clone_bundled.py"
nl = "\r\n" if "\r\n" in io.open(APP, encoding="utf-8", newline="").read()[:2000] else "\n"

t = io.open(APP, encoding="utf-8", newline="").read()

old_const = 'SPLIT_RESCUE_KEYS = ("qwen3-tts-voice-clone",)'
new_const = old_const + nl + 'SPLIT_RESCUE_FLAG = "clone_bundled_split_rescued"'
assert t.count(old_const) == 1
t = t.replace(old_const, new_const)

start = t.index("def forgive_split_keys(conn) -> list[str]:")
end = t.index("def cell_keys_of(template: dict) -> list[str]:")
NEW = '''def forgive_split_keys(conn) -> list[str]:
    """抹掉「拆分之前那次删除」留下的拉黑记录，返回这次放行的是哪几条。

    老库里删掉的是一条叫「闪寻音频」的声音工作流，拉黑记的名字却是拆完之后其中一条的
    key（qwen3-tts-voice-clone）。升级后 seed 照单全拒，三种出声方式凭空少一种、界面也
    不解释，用户只会以为是打包漏了。那次删除不可能是拒绝「参考音色」——它当时还不存在。

    只放行一次，旗标落库。不记旗标就是「放行 → 用户再删 → 名字回到名单 → 下次启动又放行」
    的无限复活，用户永远删不掉它（这条是测试先跑红才发现的）。
    代价：升级前一天刚删过参考音色的人会被放回一次，比让所有人少一种模式小得多。
    """
    if conn.execute("SELECT 1 FROM meta WHERE key=?", (SPLIT_RESCUE_FLAG,)).fetchone() is not None:
        return []
    gone = dismissed(conn)
    hit = set(SPLIT_RESCUE_KEYS)
    forgiven = sorted(gone & hit)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SPLIT_RESCUE_FLAG, "1"),
    )
    if forgiven:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (DISMISSED_META_KEY, json.dumps(sorted(gone - hit), ensure_ascii=False)),
        )
        logger.info("内置工作流放行：%s（拆分之前的删除不该吃掉新模式）", "、".join(forgiven))
    return forgiven


'''
t = t[:start] + NEW.replace("\n", nl) + t[end:]
io.open(APP, "w", encoding="utf-8", newline="").write(t)
print("rewrote forgive_split_keys")