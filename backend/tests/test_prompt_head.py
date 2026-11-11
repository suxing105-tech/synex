"""卡片页脚那句「提示词开头」的口径（app/prompt_head.py）。

真实库里的提示词开头往往不是人写的那句话：前面挂着成串 <lora:...>，或者工作流模板留下的
`subject_definitions:` 结构头。这里钉住「噪声不许上卡片」这条，样例都取自本机真实素材。
"""
from __future__ import annotations

from app.prompt_head import HEAD_WINDOW, prompt_head


def test_标签串前缀被剥掉正文才上桌():
    text = (
        "<lora:Krea2/krea2-Cc风情万种-人像:0.85> <lora:Krea2/krea2-Cc-Ins风-人像:0.90> "
        "<lora:Krea2/krea2-Cc-丰盈-人像:0.30> 一位穿米色风衣的女性站在落地窗前，柔和侧逆光"
    )
    assert prompt_head(text) == "一位穿米色风衣的女性站在落地窗前"


def test_工作流模板的结构头被剥掉():
    text = "subject_definitions:\n<Subject 1> is a tall man in a black hooded jacket"
    assert prompt_head(text).startswith("is a tall man")
    assert "subject_definitions" not in prompt_head(text)


def test_同一句里优先取中文那一段():
    # 中文用户写的那句话才是这张图的意思，英文多是模板带的描述
    text = "masterpiece, best quality, 一位撑着油纸伞的少女走在雨巷里, 8k"
    assert prompt_head(text) == "一位撑着油纸伞的少女走在雨巷里"


def test_纯英文提示词整句照给但不从单词中间切():
    head = prompt_head("a cinematic wide shot of a lone lighthouse in the storm", max_chars=30)
    assert head.endswith("…")
    assert not head[:-1].endswith("gh")  # 不许把 lighthouse 切一半


def test_短句原样返回():
    assert prompt_head("去掉文字和logo") == "去掉文字和logo"
    assert prompt_head("red cat") == "red cat"


def test_洗不出东西就回空串让前端退回文件名():
    assert prompt_head(None) == ""
    assert prompt_head("") == ""
    assert prompt_head("   ") == ""
    # 整段只有标签：洗完什么都不剩
    assert prompt_head("<lora:a/b:1.0> <lora:c/d:0.5>") == ""
    # 短到不成句的碎片也不上桌（避免卡片上一个字孤零零）
    assert prompt_head("<lora:a/b:1.0> 好") == ""


def test_读窗口是个下限保护不是上限():
    # 600 字以外还有正文也不炸，并且返回值不会长到把页脚撑爆
    long_prompt = "，".join([f"第{i}段画面描述内容" for i in range(200)])
    head = prompt_head(long_prompt)
    assert head
    assert len(head) <= 49  # 48 + 省略号
    assert HEAD_WINDOW >= 300  # 够装下实测最长的标签串前缀（7 条 lora ≈ 300 字）


def test_多余标点合并干净不留空洞():
    # 去掉 <Subject 1> 之后常见「， ，」和「， ,」这种被掏空的接缝
    text = "第一段很长很长，<Subject 1>，，第二段也很长"
    head = prompt_head(text)
    assert "，，" not in head and " " not in head

def test_字面换行符不挂在句首():
    # 工作流序列化出来的提示词里常见两个字符的 \n（反斜杠+n），不是真换行
    head = prompt_head("\\n一张产品展示图，纯色背景，柔和顶光")
    assert head == "一张产品展示图"


def test_截断窗口切在半截标签上不留残骸():
    # 实测：窗口正好断在 <lora:Krea2/天魔/Krea2-… 的中间，半截标签没有右尖括号
    half = "<lora:Krea2/天魔/Krea2-gln"
    lead = "真实中文正文。"
    text = lead + "x" * (HEAD_WINDOW - len(lead) - len(half)) + half
    assert len(text) == HEAD_WINDOW
    head = prompt_head(text)
    assert "<" not in head and "lora" not in head
    assert head == "真实中文正文"
