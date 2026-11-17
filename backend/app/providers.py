"""预设服务商注册表：OpenAI 兼容文本/视觉模型，用户只需填 API Key 即可使用。

- id: 存库的稳定标识；custom 表示手动配置。
- base_url: OpenAI 兼容根地址（后端会自动拼接 /chat/completions）。
- models: {model_id: {"label": 展示名, "recommended": 是否为推荐}}。
- default_timeout: 请求超时秒数。内置厂商的超时由注册表说了算（界面上那一格已删），
  自定义配置由用户自己填。
- note: 可选提示文案（展示给用户）。
"""
from __future__ import annotations

from fastapi import HTTPException

CUSTOM_ID = "custom"

# 内置厂商的请求超时：界面上那一格删了，值归这里定。
# 十分钟是给思考档留余地——GLM / Kimi / Qwen 开了思考，一张图反推几分钟是正常节奏，
# 卡在两分钟上只会让人以为服务坏了。地址不通另有 30 秒的 connect 闸兜着，不会白等满十分钟。
PRESET_TIMEOUT_SECONDS = 600
# 自定义配置的开档值：那一格还在界面上，人想调短随时调。
CUSTOM_TIMEOUT_SECONDS = 120

PRESETS: dict[str, dict] = {
    "openai": {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models": {
            "gpt-4o-mini": {"label": "GPT-4o mini", "recommended": True},
            "gpt-4o": {"label": "GPT-4o", "recommended": False},
            "gpt-4.1-mini": {"label": "GPT-4.1 mini", "recommended": False},
            "gpt-4.1": {"label": "GPT-4.1", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "console_url": "https://platform.openai.com/api-keys",
    },
    "gemini": {
        "id": "gemini",
        "name": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "models": {
            "gemini-2.5-flash": {"label": "Gemini 2.5 Flash", "recommended": True},
            "gemini-2.0-flash": {"label": "Gemini 2.0 Flash", "recommended": False},
            "gemini-2.5-pro": {"label": "Gemini 2.5 Pro", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "console_url": "https://aistudio.google.com/apikey",
    },
    "qwen": {
        "id": "qwen",
        "name": "通义千问 Qwen",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": {
            "qwen2.5-vl-72b-instruct": {"label": "Qwen2.5-VL-72B", "recommended": True},
            "qwen2.5-vl-32b-instruct": {"label": "Qwen2.5-VL-32B", "recommended": False},
            "qwen-vl-max": {"label": "Qwen-VL-Max", "recommended": False},
            "qwen-vl-plus": {"label": "Qwen-VL-Plus", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "console_url": "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
    },
    "doubao": {
        "id": "doubao",
        "name": "豆包（火山方舟）",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "models": {
            "doubao-seed-1-6-vision-250815": {"label": "Doubao Seed 1.6 Vision", "recommended": True},
            "doubao-1-5-vision-pro-250328": {"label": "Doubao 1.5 Vision Pro", "recommended": False},
            "doubao-1-5-vision-lite-250328": {"label": "Doubao 1.5 Vision Lite", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "note": "下拉为常见名称；若你的账号使用 endpoint id（ep-...），在反推面板的模型下拉里直接输入它。",
        "console_url": "https://ark.volcengine.com/region:cn-beijing/apikey",
    },
    "zhipu": {
        "id": "zhipu",
        "name": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": {
            # 这张表不只是「问不到智谱自己时兜底」：智谱的 GET /models 只报这个账号开通的那几个
            # （真机一把 Key 报回 12 条，能读图的只有 glm-4.6v 和 glm-5v-turbo，连 4.6V-Flash 都没报），
            # 所以「清单里不报、其实能用」的那几张得在这儿写着，两边并起来才不重不漏
            # （并法见 reverse_prompts.list_config_models）。
            # 名字里带不带 v 不算数：glm-5.3 是纯文本，glm-5.3-flash 反倒是 GLM-5 系列里
            # 第一个原生能读图/读视频的，别按字样把它筛掉。
            "glm-4.6v": {"label": "GLM-4.6V", "recommended": True},
            "glm-5.3-flash": {"label": "GLM-5.3 Flash（读图）", "recommended": False},
            "glm-5.3-flashx": {"label": "GLM-5.3 FlashX（读图）", "recommended": False},
            "glm-5v-turbo": {"label": "GLM-5V Turbo", "recommended": False},
            "glm-4.6v-flash": {"label": "GLM-4.6V Flash", "recommended": False},
            "glm-4.5v": {"label": "GLM-4.5V", "recommended": False},
            "glm-4.1v-thinking-flash": {"label": "GLM-4.1V Thinking Flash", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "note": "反推只能用看得懂图的那几档：GLM-4.6V / GLM-4.6V Flash / GLM-5.3 Flash / GLM-5V Turbo。"
                "GLM-5、GLM-5.1、GLM-5.2、GLM-5.3、GLM-4.7 这些是纯文本档，收不到图，反推会失败；"
                "它们会出现在这家的模型清单里，但没列进反推这一列。",
        "console_url": "https://open.bigmodel.cn/usercenter/apikeys",
    },
    "siliconflow": {
        "id": "siliconflow",
        "name": "硅基流动 SiliconFlow",
        "base_url": "https://api.siliconflow.cn/v1",
        "models": {
            "Qwen/Qwen2.5-VL-72B-Instruct": {"label": "Qwen2.5-VL-72B", "recommended": True},
            "Qwen/Qwen2.5-VL-32B-Instruct": {"label": "Qwen2.5-VL-32B", "recommended": False},
            "deepseek-ai/deepseek-vl2": {"label": "DeepSeek-VL2", "recommended": False},
            "Qwen/Qwen2-VL-72B-Instruct": {"label": "Qwen2-VL-72B", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "console_url": "https://cloud.siliconflow.cn/account/apikey",
    },
    "moonshot": {
        "id": "moonshot",
        "name": "Kimi / Moonshot",
        "base_url": "https://api.moonshot.cn/v1",
        "models": {
            "moonshot-v1-8k-vision-preview": {"label": "Moonshot Vision 8K", "recommended": True},
            "moonshot-v1-32k-vision-preview": {"label": "Moonshot Vision 32K", "recommended": False},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "console_url": "https://platform.kimi.com/console/api-keys",
    },
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek（魔搭）",
        "base_url": "https://api-inference.modelscope.cn/v1",
        "models": {
            "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {"label": "DeepSeek V4 Flash Vision", "recommended": True},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "note": "使用 ModelScope（魔搭）推理 API Key；模型支持图片识别。",
        "console_url": "https://modelscope.cn/my/myaccesstoken",
    },
    # RunningHub：官方 LLM API 与 OpenAI 协议兼容，所以它和别家一样进这个下拉。
    # 但它有两处和别家不同，落在下面这两个字段上：
    # - credential_scope=cloud：这把 Key 的家在「RunningHub 云端生成」那条账号（gen_accounts）里，
    #   这条模型配置不再另存一份。RunningHub 本来就是一把 Key 走天下，存两份迟早对不上。
    # - models_dynamic：能反推的模型 id 由它自己和用户账号决定，抄在这里第二天就过期，
    #   所以清单走 GET /models 现拉，拉不到就让人手填。
    "runninghub": {
        "id": "runninghub",
        "name": "RunningHub",
        "base_url": "https://llm.runninghub.cn/v1",
        "models": {},
        "models_dynamic": True,
        "credential_scope": "cloud",
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        # 这一家除文本反推外，还接了图像/视频/音频生成 API。
        "capabilities": ("text", "image", "video", "audio"),
        # 第二把 Key（工作流 API 密钥·消费级-会员）：官方要求工作流与模型 API 各用一把
        "workflow_key": True,
        "console_url": "https://www.runninghub.cn",
        "note": "一把 Key 走天下：这里的 Key 与「RunningHub 云端生成」共用同一把，只存一份，"
                "在任一处改都一起生效。反推按 token 计价（CNY / 1M tokens），"
                "不吃云端生成那两道 RH币花费上限；官方要求两类接口都用企业级-共享 API Key。"
                "云端工作流不算在内——它要另配「工作流 API 密钥（消费级-会员）」，扣的是 RH币。",
    },
    "minimax": {
        "id": "minimax",
        "name": "MiniMax",
        "base_url": "https://api.minimax.cn/v1",
        "models": {
            "MiniMax-H3-Image": {"label": "MiniMax-H3-Image", "recommended": True, "capability": "image"},
            "MiniMax-H3": {"label": "MiniMax-H3 视频", "recommended": True, "capability": "video"},
            "speech-2.8-hd": {"label": "Speech 2.8 HD", "recommended": True, "capability": "audio"},
            "MiniMax-M3.1-Flash": {"label": "MiniMax M3.1 Flash", "recommended": True, "capability": "text"},
            "MiniMax-M3": {"label": "MiniMax M3", "recommended": False, "capability": "text"},
        },
        "default_timeout": PRESET_TIMEOUT_SECONDS,
        "format": "openai",
        "capabilities": ("text", "image", "video", "audio"),
        "console_url": "https://platform.minimax.cn",
        "note": "文本模型使用 MiniMax-M3.1-Flash 或 MiniMax-M3；图片使用 MiniMax-H3-Image，视频使用 MiniMax-H3，音频使用 Speech 2.8 HD；"
                "Key 在 MiniMax 开放平台创建。H3 视频需账号开通对应的按量 API；参考音频复刻需完成官方个人或企业认证。",
    },
}


def list_presets():
    """返回前端可展示的预设列表（不含任何密钥）。"""
    result = []
    for preset in PRESETS.values():
        models = [
            {"id": mid, "label": info["label"], "recommended": info.get("recommended", False)}
            for mid, info in preset["models"].items()
        ]
        result.append({
            "id": preset["id"],
            "name": preset["name"],
            "base_url": preset["base_url"],
            "models": models,
            "default_timeout": preset["default_timeout"],
            "note": preset.get("note", ""),
            # 这两个开关决定界面长什么样：清单是现拉的还是抄来的、Key 是自家存还是共用
            "models_dynamic": bool(preset.get("models_dynamic")),
            "credential_scope": preset.get("credential_scope", "local"),
            # 服务商选择页按能力过滤：没接的路数不报（只有 RunningHub 真接了三条收费模型 API）
            "capabilities": list(preset.get("capabilities") or ["text"]),
            "workflow_key": bool(preset.get("workflow_key")),
            "console_url": preset.get("console_url", ""),
        })
    return result


def get_preset(preset_id):
    """返回预设字典；custom / None 返回 None；未知预设抛 422。"""
    if preset_id is None or preset_id == CUSTOM_ID:
        return None
    preset = PRESETS.get(preset_id)
    if preset is None:
        raise HTTPException(422, "不支持的服务商预设")
    return preset


def request_timeout(config):
    """这一条配置发请求该等多久。

    内置厂商只认注册表：那一格已经从界面上删了，库里那一份多半是老版本留下的 120，
    跟着用等于「删了入口还留着旧值」——老配置永远等不到这次改长的时间。
    自定义配置那一格还在，按人填的走。
    """
    preset = PRESETS.get((config or {}).get("provider") or "")
    if preset:
        return preset["default_timeout"]
    return int((config or {}).get("timeout") or CUSTOM_TIMEOUT_SECONDS)


def capabilities_for(provider_id):
    """预设服务商公开声明的用途；自定义地址默认作为文本/视觉模型使用。"""
    preset = get_preset(provider_id)
    return list((preset or {}).get("capabilities") or ["text"])


def model_label(preset, model_id):
    info = preset["models"].get(model_id)
    return info["label"] if info else model_id
