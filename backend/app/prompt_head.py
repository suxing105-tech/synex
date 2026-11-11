"""提示词「开头那一截」——卡片页脚要显示的东西，全站只有这一处口径。

为什么在后端算而不是前端：feed 一页 200 条，前端要么收整份提示词（Krea2 那种一条就 4KB，
一页几百 KB 白跑），要么每条自己正则一遍（AGENTS.md §7.4 不许在列表渲染里做同步重活）。
这里读 600 字符、当场收成一短句，正文仍然只在详情接口里出现。

为什么要先洗一遍：真实 ComfyUI 提示词的开头往往不是人写的那句话，而是
`<lora:Krea2/xxx:0.85>` 这类标签串（实测有位用户连挂 7 条 lora 才到正文）、
或者 `subject_definitions:` 这种工作流模板留下的结构头。直接取前 18 字会把这些噪声摆到每张卡上。
"""
from __future__ import annotations

import re

# 读取窗口：够装下实测最长的标签串前缀（7 条 lora ≈ 300 字）再多留一句正文。
HEAD_WINDOW = 600

_TAG = re.compile(r"<[^<>]*>")          # <lora:...> <embedding:...> <Subject 1>
_DANGLING = re.compile(r"<[^<>]*$")        # 被截断窗口切掉的半个标签尾巴
_LABEL = re.compile(r"^[\w\u4e00-\u9fff .+-]{0,24}[:：]\s*")  # subject_definitions: / 【风格】：
_CLAUSE = re.compile(r"[，,。.；;！!？?\n]+")
_CJK = re.compile(r"[\u4e00-\u9fff]")
_PUNCT_RUN = re.compile(r"[，,。.；;、]{2,}")


def prompt_head(text: str | None, max_chars: int = 48) -> str:
    """把整段提示词收成一句能上卡片的话；洗不出东西就回空串（前端据此退回文件名）。"""
    if not text:
        return ""
    body = str(text)[:HEAD_WINDOW]
    # 工作流序列化出来的提示词里常有字面 \n（两个字符，不是真换行），不处理会挂在句首
    body = body.replace("\\n", " ").replace("\\r", " ").replace("\\t", " ")
    body = _TAG.sub(" ", body)
    # 截断窗口正好切在半个标签上时（实测：<lora:Krea2/天魔/Krea2-… 在第 600 字断掉），
    # 剩下的半截没有右尖括号，_TAG 拿它没办法，得单独扫掉尾巴
    body = _DANGLING.sub(" ", body)
    body = re.sub(r"\s+", " ", body).strip()
    # 结构头可能连着好几层（"subject_definitions: note:"），剥到不像标签为止
    for _ in range(3):
        stripped = _LABEL.sub("", body).strip()
        if stripped == body:
            break
        body = stripped
    body = _PUNCT_RUN.sub("，", body).strip(" ，,。.；;、")
    if not body:
        return ""
    clauses = [c.strip(" \t-_·") for c in _CLAUSE.split(body)]
    clauses = [c for c in clauses if len(c) >= 4]
    if not clauses:
        clauses = [body]
    # 中文用户写的那句话才是这条图的意思，英文常是模板带的负向描述
    pick = next((c for c in clauses if _CJK.search(c)), clauses[0])
    if len(pick) < 2:
        return ""  # 一个字上卡片不如不上，让前端退回文件名
    if len(pick) <= max_chars:
        return pick
    # 英文单词别从中间切：能退到空格就退
    window = pick[:max_chars]
    if " " in window and _CJK.search(pick) is None:
        window = window.rsplit(" ", 1)[0]
    return window.rstrip() + "…"
