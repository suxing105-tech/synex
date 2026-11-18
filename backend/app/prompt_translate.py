"""提示词框右下角那颗中英互译：把手上这一句换成另一种语言，只做翻译这一件事。

为什么单独一个模块，不并进 prompt_skills：优化是「照一条技能的写法重写」，技能正文用户改得动；
翻译要的恰恰相反——内容一个字都不许动，只换语言。把这条规矩做成一条技能塞进清单，等于留了个
开关：谁改一行正文，就能把台词、参考编号、时间轴一起翻掉。

模型不在这里挑，吃的是反推那一份默认配置（resolve_model 存在的意义就是「一处配置几处共用」），
用户只需要配一次。

和镜头拆分那一颗（routes/video_prompts.translate_segment）也不一样：那一颗一个版本只存一条译文、
再点直接读缓存；提示词框这一颗是「译文 ↔ 原文」来回切，第三下必须真翻一遍——人在这两下之间是
会在框里改字的，读缓存等于把旧译文扣在新原文上。
"""
from __future__ import annotations

from fastapi import HTTPException

from . import prompt_skills, reverse_prompts, video_prompts

# 目标语言在指令里出现两次（开头一次、第五条一次），写成占位符再换。
# 不用 str.format：指令里本来就带大括号（Seedance 的台词就是花括号包的），format 会撞上。
TARGET_TOKEN = "「目标语言」"

# 一句话口径：只翻描述文字，标记与台词一律照抄。
# 之所以把「不许动」的东西一条条点名，而不是笼统写一句「保留格式」：
# 提示词里最要命的三类——参考编号（翻掉就指错格）、时间轴（换算就错帧）、
# 台词（翻译等于换个人说话）——都值得单独占一条，模型漏掉哪一类都能对得上号。
TRANSLATE_INSTRUCTION = (
    "你是 AI 生图与视频提示词的专业译者。把用户给出的提示词正文翻译成「目标语言」，只做翻译这一件事。\n"
    "1) 不增不减：段落数、空行位置、行的先后顺序原样保留。不合并、不重排、不补标题、不加解释、"
    "不复述原文、不把两种语言并排放，最后一行译完就停。\n"
    "2) 结构与标记原样照抄，不翻译、不改名、不改大小写与空格：六段段名 subject_definitions:、summary:、"
    "retention_analysis:、detailed_description:、overall_soundscape:、non_diegetic_music:；"
    "[Shot N] 与 [镜头 N] 这类镜头标号；<Subject N>、<Picture N>、<Video N>、<Audio N>；"
    "@图片N、@视频N、@音频N；(S1) 这类说话人编号；花括号、尖括号、圆括号、方头括号这些符号本身。\n"
    "3) 会被念出来、或者本来就该显示在画面上的字，一个都不改：<d>[Chinese] 台词 </d> 整块照抄"
    "（连同中括号里的语种标记一起），花括号里的台词照抄，英文双引号里的画面文字照抄，〖字幕〗里的字照抄。\n"
    "4) 数字与时间照抄（0-3 秒、3.5-second、MM:SS.mmm、4K、9:16、12），不换算、不四舍五入、不补单位。\n"
    "5) 上面没点名的都是描述文字——镜头、动作、光影、材质、环境、情绪，以及音效与配乐那些描写："
    "译成自然、简洁、可执行的「目标语言」，镜头术语用该行当通用的说法（特写 close-up、推镜 push in、"
    "俯拍 high angle）。措辞可以顺，信息不许加也不许减。"
)

TARGET_WORDS = video_prompts.TRANSLATION_LABELS


async def translate(text: str) -> dict:
    """翻一次。一行都不写库：译文和原文的那点来回，留在会话里就够。

    方向不用人挑：正文主体是中文就出英文，反之出中文（和镜头拆分那颗同一个判法）。
    """
    body = str(text or "").strip()
    if not body:
        raise HTTPException(422, "提示词是空的，没什么可翻译")
    source = video_prompts.dominant_language(body)
    target = video_prompts.translation_language(body)
    config, key = prompt_skills.resolve_model()
    # 这条指令是死的常量，用户能打字的只有正文，而正文走的是 content 不是 system，
    # 所以这里不存在「把密钥拼进系统提示」那条路（测试钉着这个不变量）。
    instruction = TRANSLATE_INSTRUCTION.replace(TARGET_TOKEN, TARGET_WORDS[target])
    answer = await reverse_prompts.request_model(
        config, key, [{"type": "text", "text": body}], instruction,
        output_rule=video_prompts.TRANSLATION_OUTPUT_RULE)
    result = video_prompts.clean_translation(answer)
    if not result:
        raise HTTPException(502, "模型只回了一层壳，没回译文，请重试或换一家模型")
    return {"text": result, "source_language": source, "target_language": target,
            "model_name": config["name"], "model": config["model"]}
