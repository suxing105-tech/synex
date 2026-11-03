"""预设服务商注册表：OpenAI 兼容视觉模型，用户只需填 API Key 即可使用。

- id: 存库的稳定标识；custom 表示手动配置。
- base_url: OpenAI 兼容根地址（后端会自动拼接 /chat/completions）。
- models: {model_id: {"label": 展示名, "recommended": 是否为推荐}}。
- default_timeout: 默认超时秒数。
- note: 可选提示文案（展示给用户）。
"""
from __future__ import annotations

from fastapi import HTTPException

CUSTOM_ID = "custom"

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
        "default_timeout": 120,
        "format": "openai",
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
        "default_timeout": 120,
        "format": "openai",
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
        "default_timeout": 120,
        "format": "openai",
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
        "default_timeout": 120,
        "format": "openai",
        "note": "下拉为常见名称；若你的账号使用 endpoint id（ep-...），可在高级设置里覆盖模型 ID。",
    },
    "zhipu": {
        "id": "zhipu",
        "name": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": {
            "glm-4.5v": {"label": "GLM-4.5V", "recommended": True},
            "glm-4v-plus": {"label": "GLM-4V-Plus", "recommended": False},
            "glm-4v": {"label": "GLM-4V", "recommended": False},
            "glm-4.1v-thinking-flash": {"label": "GLM-4.1V Thinking Flash", "recommended": False},
        },
        "default_timeout": 120,
        "format": "openai",
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
        "default_timeout": 120,
        "format": "openai",
    },
    "moonshot": {
        "id": "moonshot",
        "name": "Kimi / Moonshot",
        "base_url": "https://api.moonshot.cn/v1",
        "models": {
            "moonshot-v1-8k-vision-preview": {"label": "Moonshot Vision 8K", "recommended": True},
            "moonshot-v1-32k-vision-preview": {"label": "Moonshot Vision 32K", "recommended": False},
        },
        "default_timeout": 120,
        "format": "openai",
    },
    "deepseek": {
        "id": "deepseek",
        "name": "DeepSeek（魔搭）",
        "base_url": "https://api-inference.modelscope.cn/v1",
        "models": {
            "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {"label": "DeepSeek V4 Flash Vision", "recommended": True},
        },
        "default_timeout": 120,
        "format": "openai",
        "note": "使用 ModelScope（魔搭）推理 API Key；模型支持图片识别。",
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
        "default_timeout": 120,
        "format": "openai",
        "note": "一把 Key 走天下：这里的 Key 与「RunningHub 云端生成」共用同一把，只存一份，"
                "在任一处改都一起生效。反推按 token 计价（CNY / 1M tokens），"
                "不吃云端生成那两道 RH币花费上限；官方要求两类接口都用企业级-共享 API Key。",
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


def model_label(preset, model_id):
    info = preset["models"].get(model_id)
    return info["label"] if info else model_id
