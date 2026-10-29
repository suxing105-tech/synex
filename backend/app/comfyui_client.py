"""本机 ComfyUI 的 HTTP 客户端（一键同款执行链路用）。

分工：integrations/comfyui.py 是"探测 + 落地临时工作流文件"的同步老代码；
这里是有真实执行链路之后才需要的部分——上传参考图、排队、轮询历史、取回产物、
读 object_info。统一用 httpx（后端已声明的依赖，不新增第三方包）。

错误一律抛 ComfyUIError（中文 message），路由层翻成 HTTPException，前端 toast
直接能显示，不用让人去翻 Python 栈。
"""
from __future__ import annotations

import random
from typing import Any

import httpx

DEFAULT_TIMEOUT = 20.0
# 产物可能是 2K PNG，下载单独给长超时。
DOWNLOAD_TIMEOUT = 120.0
# 种子留 47 位：ComfyUI 整型控件上限是 2**64-1，但 47 位内 JS 也能精确表示。
SEED_LIMIT = 2 ** 47


class ComfyUIError(RuntimeError):
    """ComfyUI 调用失败。

    message 是面向用户的中文说明，status 是 HTTP 状态码（连不上时为 None）。
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def _short(text: str, limit: int = 200) -> str:
    return " ".join((text or "").split())[:limit]


def widget_spec(raw: Any) -> dict[str, Any]:
    """把 object_info 的 widget 定义归一。

    ComfyUI 两种历史形状都要吃：

      新版（实测 0.42）：["COMBO", {"options": [...], "default": ...}]
      旧版：            [["a", "b"], {"default": "a"}]
                        [512, {"default": 512, "min": 16, "max": 4096}]

    返回 {kind, options, default, min, max, step}，kind ∈ combo/int/float/other。
    0.42 里文件类下拉的 options 可能是 {"contentOptions": [...]}，一并摊平。
    """
    out: dict[str, Any] = {"kind": "other", "options": [], "default": None, "min": None, "max": None, "step": None}
    if not isinstance(raw, list) or not raw:
        return out
    head = raw[0]
    meta = raw[1] if len(raw) > 1 and isinstance(raw[1], dict) else {}
    if isinstance(head, str):
        kind = {"COMBO": "combo", "INT": "int", "FLOAT": "float"}.get(head.upper())
        if kind is None:
            return out
        out["kind"] = kind
    elif isinstance(head, list):
        out["kind"] = "combo"
        out["options"] = [str(x) for x in head if isinstance(x, str)]
    elif isinstance(head, (int, float)) and not isinstance(head, bool):
        floats = [v for v in (head, meta.get("default"), meta.get("step")) if isinstance(v, float)]
        out["kind"] = "float" if floats else "int"
    else:
        return out
    options = meta.get("options")
    if isinstance(options, list):
        out["options"] = [str(x) for x in options if isinstance(x, str)]
    elif isinstance(options, dict):
        inner = options.get("contentOptions")
        if isinstance(inner, list):
            out["options"] = [str(x) for x in inner if isinstance(x, str)]
    for key in ("default", "min", "max", "step"):
        if meta.get(key) is not None:
            out[key] = meta[key]
    return out


def random_seed() -> int:
    return random.randint(1, SEED_LIMIT)


class ComfyUIClient:
    """一个 ComfyUI 服务地址一个客户端；测试时用 transport 塞假服务。"""

    def __init__(
        self,
        base_url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = (base_url or "").rstrip("/") or "http://127.0.0.1:8188"
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "ComfyUIClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    # ---------- 内部 ----------

    async def _call(
        self,
        method: str,
        path: str,
        *,
        action: str,
        json_body: Any = None,
        params: dict[str, Any] | None = None,
        files: Any = None,
        data: Any = None,
        timeout: float | None = None,
        as_json: bool = True,
    ) -> Any:
        try:
            resp = await self._client.request(
                method,
                path,
                json=json_body,
                params=params,
                files=files,
                data=data,
                timeout=timeout or self._client.timeout.read or DEFAULT_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            raise ComfyUIError(
                f"连不上 ComfyUI（{self.base_url}），请确认它已经启动、地址没填错。"
            ) from exc
        if resp.status_code >= 400:
            raise ComfyUIError(
                f"{action}失败：ComfyUI 返回 {resp.status_code} {_short(resp.text)}",
                status=resp.status_code,
            )
        if not as_json:
            return resp.content
        try:
            return resp.json()
        except ValueError as exc:
            raise ComfyUIError(f"{action}失败：ComfyUI 返回的不是 JSON。{_short(resp.text)}") from exc

    # ---------- 探测 ----------

    async def probe(self) -> bool:
        """/system_stats 或 / 任一 2xx 就算在跑；连不上返回 False，不抛错。"""
        for path in ("/system_stats", "/"):
            try:
                resp = await self._client.get(path, timeout=3.0)
            except httpx.HTTPError:
                continue
            if resp.status_code < 300:
                return True
        return False

    # ---------- 节点定义 ----------

    async def object_info(self, class_types: list[str]) -> dict[str, Any]:
        """按需取节点类定义；单个类取失败就跳过（ComfyUI 没开时导入也不能炸）。"""
        out: dict[str, Any] = {}
        for name in list(dict.fromkeys(class_types)):
            try:
                data = await self._call("GET", "/object_info/" + name, action="读取节点定义", timeout=6.0)
            except ComfyUIError:
                continue
            if isinstance(data, dict):
                out.update(data)
        return out

    # ---------- 参考图 ----------

    async def upload_image(self, filename: str, content: bytes, content_type: str | None = None) -> dict[str, str]:
        """把参考图塞进 ComfyUI 的 input 目录，返回 {name, subfolder, type}。

        overwrite=true：同名重传是"换了一张参考图"，不是要留两份。文件名由调用方
        带图片 id 与内容 hash 生成，绝不会撞上用户 input 目录里的原始文件。
        """
        result = await self._call(
            "POST",
            "/upload/image",
            action="上传参考图",
            files={"image": (filename, content, content_type or "application/octet-stream")},
            data={"overwrite": "true", "type": "input"},
        )
        if not isinstance(result, dict) or not result.get("name"):
            raise ComfyUIError("上传参考图失败：ComfyUI 没有返回文件名。")
        return {
            "name": str(result["name"]),
            "subfolder": str(result.get("subfolder") or ""),
            "type": str(result.get("type") or "input"),
        }

    # ---------- 排队与取结果 ----------

    async def queue(
        self,
        workflow: dict[str, Any],
        client_id: str,
        titles: dict[str, str] | None = None,
    ) -> str:
        result = await self._call(
            "POST", "/prompt", action="提交生成任务",
            json_body={"prompt": workflow, "client_id": client_id},
        )
        if not isinstance(result, dict):
            raise ComfyUIError("提交生成任务失败：ComfyUI 返回了意外的内容。")
        errors = result.get("node_errors") or {}
        if errors:
            raise ComfyUIError(node_errors_message(errors, titles))
        prompt_id = result.get("prompt_id")
        if not prompt_id:
            raise ComfyUIError("提交生成任务失败：ComfyUI 没有返回 prompt_id。")
        return str(prompt_id)

    async def history(self, prompt_id: str) -> dict[str, Any]:
        """取一条任务的历史；还没跑完时 ComfyUI 返回空 dict。"""
        try:
            result = await self._call("GET", "/history/" + prompt_id, action="读取生成结果")
        except ComfyUIError as exc:
            if exc.status == 404:
                return {}
            raise
        return result if isinstance(result, dict) else {}

    async def view(self, filename: str, subfolder: str = "", type_: str = "output") -> bytes:
        raw = await self._call(
            "GET", "/view",
            action="取回图片 " + filename,
            params={"filename": filename, "subfolder": subfolder, "type": type_},
            as_json=False,
            timeout=DOWNLOAD_TIMEOUT,
        )
        return raw

    # ---------- 中止 ----------

    async def interrupt(self) -> bool:
        try:
            await self._call("POST", "/interrupt", action="中止生成", json_body={})
        except ComfyUIError:
            return False
        return True

    async def delete_queue_items(self, prompt_ids: list[str]) -> bool:
        if not prompt_ids:
            return False
        try:
            await self._call("POST", "/queue", action="移出队列", json_body={"delete": list(prompt_ids)})
        except ComfyUIError:
            return False
        return True


def node_errors_message(errors: dict[str, Any], titles: dict[str, str] | None = None) -> str:
    """把 /prompt 的 node_errors 翻成「哪个节点、为什么」的一行中文。"""
    parts: list[str] = []
    for node_id, info in list(errors.items())[:5]:
        title = (titles or {}).get(str(node_id)) or ("节点 " + str(node_id))
        items = info.get("errors") if isinstance(info, dict) else None
        if isinstance(items, list) and items:
            for item in items[:2]:
                if not isinstance(item, dict):
                    continue
                message = str(item.get("message") or "").strip()
                details = str(item.get("details") or "").strip()
                reason = " ".join(x for x in (message, details) if x)
                parts.append("：".join(x for x in (title, reason) if x))
        else:
            parts.append(title)
    if not parts:
        return "工作流在 ComfyUI 里没通过校验，请打开 ComfyUI 查看标红的节点。"
    return "工作流在 ComfyUI 里没通过校验：" + "；".join(parts)
