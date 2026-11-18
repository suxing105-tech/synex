"""提示词框右下角那颗中英互译：请求里到底写了什么、方向怎么判、回来的壳怎么剥。

翻译会真的打模型，所以一律打桩 reverse_prompts.request_model（和优化那批用例同一个做法）：
要钉的是「我们有没有把要翻成哪种语言明说出来」「标记和台词有没有被要求照抄」这类事，
真发一次请求既花钱也测不到这些。
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import prompt_translate, reverse_prompts, video_prompts
from app.routes import reverse_prompts as reverse_routes
from app.routes.prompt_skills import router


@pytest.fixture
def client(init_db):
    app = FastAPI()
    app.include_router(router)
    # 模型配置和默认模型挂的是反推那一套接口：翻译直接吃它，测试就得一起挂上
    app.include_router(reverse_routes.router)
    with TestClient(app) as client:
        yield client


@pytest.fixture
def model(client):
    """配一家服务商并设成反推默认——翻译和优化一样，只认这一处配置。"""
    config = client.post("/api/model-configs", json={
        "name": "文本模型", "base_url": "https://example.com/api/v1", "model": "text-pro", "timeout": 60,
    }).json()
    client.put("/api/reverse-prompt-settings", json={"default_model_id": config["id"], "instruction": "反推用的指令"})
    return config


class Capture:
    """假模型：记下拼出去的请求，回一句固定译文。"""

    def __init__(self, answer="A woman walks into the rain."):
        self.calls = []
        self.answer = answer

    async def __call__(self, config, key, content, instruction, output_rule=""):
        self.calls.append({"config": config, "key": key, "content": content,
                           "instruction": instruction, "output_rule": output_rule})
        return self.answer


def translate(client, text="一个女人在雨里慢慢往前走，镜头从背后跟上来。"):
    return client.post("/api/translate-prompt", json={"text": text})


# ---------- 方向：由正文主体语言判，而且要明说给模型听 ----------


def test_chinese_body_goes_to_english_and_the_target_is_named(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    result = translate(client)
    assert result.status_code == 200, result.text
    assert result.json() == {"text": "A woman walks into the rain.", "source_language": "zh",
                             "target_language": "en", "model_name": "文本模型", "model": "text-pro"}
    instruction = capture.calls[0]["instruction"]
    # 「翻译成指定语言」是镜头拆分那一颗的坑：算出来的语种只进库，模型从头到尾没见过要翻成哪种。
    # 这颗必须把语种写进指令，占位符不许漏出去。
    assert "翻译成英文" in instruction and "译成自然、简洁、可执行的英文" in instruction
    assert prompt_translate.TARGET_TOKEN not in instruction


def test_english_body_goes_back_to_chinese(client, model, monkeypatch):
    capture = Capture("一个女人走进雨里。")
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    result = translate(client, "A woman walks into the rain, the camera following from behind.")
    assert result.json()["source_language"] == "en" and result.json()["target_language"] == "zh"
    assert "翻译成中文" in capture.calls[0]["instruction"]


# ---------- 只翻描述：标记、时间、台词一律照抄 ----------


def test_the_instruction_names_everything_that_must_stay_put(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    assert translate(client).status_code == 200
    instruction = capture.calls[0]["instruction"]
    # 六段段名是本地工作流往节点里填词的键，被译成「详细描述：」那一格就吃不到东西
    for token in ("subject_definitions:", "summary:", "retention_analysis:", "detailed_description:",
                  "overall_soundscape:", "non_diegetic_music:", "[Shot N]", "<Subject N>", "<Picture N>",
                  "<Video N>", "<Audio N>", "@图片N", "@视频N", "@音频N", "(S1)"):
        assert token in instruction, token
    # 台词是念出来的东西，翻它就是换个人说话：整块连中括号里的语种标记一起照抄
    assert "<d>[Chinese]" in instruction and "花括号里的台词照抄" in instruction
    # 时间不换算：0-3 秒写成 0-3 seconds 是一回事，换算成 0:03 就把时间轴搞坏了
    assert "不换算、不四舍五入、不补单位" in instruction
    assert "只做翻译这一件事" in instruction


def test_only_the_body_goes_out_and_the_output_rule_stays_bare(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    assert translate(client, "原文一句").status_code == 200
    call = capture.calls[0]
    # 翻译不带图：这是纯文字换语言，多带一张参考只会让它顺手加描述
    assert call["content"] == [{"type": "text", "text": "原文一句"}]
    assert call["output_rule"] == video_prompts.TRANSLATION_OUTPUT_RULE
    # 模型继续吃反推那一份配置，不另开一处
    assert call["config"]["model"] == "text-pro" and call["key"] == ""


# ---------- 回来的那一层壳 ----------


def test_wrappers_are_stripped_and_an_empty_answer_is_reported(client, model, monkeypatch):
    fence = "```"
    monkeypatch.setattr(reverse_prompts, "request_model", Capture(fence + "\n译文：正文一句\n" + fence))
    assert translate(client).json()["text"] == "正文一句"
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("   \n" + fence + "\n\n" + fence + "  \n"))
    assert translate(client).status_code == 502


def test_the_key_never_rides_along_in_the_instruction(client, model, monkeypatch):
    # 指令是死的常量、正文走 content，这条路本来碰不到密钥；钉住它是因为反推和优化那边
    # 的指令是用户改得动的文本，这条哪天也跟着变成可配置文本时，漏了就红。
    monkeypatch.setattr(prompt_translate.prompt_skills, "resolve_model",
                        lambda: ({"name": "魔搭", "model": "deepseek"}, "sk-abcdefghijklmnopqrstuvwxyz"))
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    assert translate(client).status_code == 200
    call = capture.calls[0]
    assert call["key"] == "sk-abcdefghijklmnopqrstuvwxyz", "密钥照旧交给 request_model 打请求头"
    assert "sk-abcdefghijklmnopqrstuvwxyz" not in call["instruction"] + str(call["content"])


def test_translate_writes_nothing_to_the_database(client, model, init_db, monkeypatch):
    monkeypatch.setattr(reverse_prompts, "request_model", Capture("translated"))

    def snapshot():
        return {table: init_db.main().execute("SELECT count(*) FROM " + table).fetchone()[0]
                for table in ("prompt_skills", "prompt_skill_settings", "video_prompt_translations",
                              "video_prompt_records", "model_configs", "images")}

    before = snapshot()
    assert translate(client).status_code == 200
    assert snapshot() == before, "译文是给人来回看的，不落库；第三下要重新翻"


# ---------- 该顶回来的几种情况 ----------


def test_empty_body_is_refused_without_calling_the_model(client, model, monkeypatch):
    capture = Capture()
    monkeypatch.setattr(reverse_prompts, "request_model", capture)
    assert translate(client, "   ").status_code == 422
    assert capture.calls == []


def test_oversized_body_is_refused(client, model, monkeypatch):
    monkeypatch.setattr(reverse_prompts, "request_model", Capture())
    assert translate(client, "字" * 50_001).status_code == 422


def test_missing_default_model_says_where_to_fix_it(client, monkeypatch):
    monkeypatch.setattr(reverse_prompts, "request_model", Capture())
    result = translate(client)
    assert result.status_code == 422
    assert "反推提示词" in result.json()["detail"]


def test_helpers_agree_with_the_backend_language_call():
    assert video_prompts.dominant_language("一个女人走进雨里。") == "zh"
    assert video_prompts.dominant_language("A woman walks into the rain.") == "en"
    assert prompt_translate.TARGET_WORDS == {"zh": "中文", "en": "英文"}
