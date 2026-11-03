"""RunningHub 的 HTTP 客户端（只走收费模型 API 那条路）。

已照官方文档抄录的四个端点（2026-11-03 实抓）：

    POST /openapi/v2/media/upload/binary   multipart file → data.download_url（签名 URL，约 1 天）
    POST /openapi/v2/<模型路径>            json → {taskId, status, errorCode, errorMessage, results}
    POST /openapi/v2/query                 {"taskId"} → 同上，成功时 results 是 [{url, outputType}]
    POST /openapi/v2/price-preview/<模型路径>  同一份请求体 → 价格预估
    POST /uc/openapi/accountStatus         → remainCoins（RH币余额）

三件事决定了实现形状：
1. 所有模型共用「提交 + 查询」，差异只在提交那一层，所以这里只有一个类；
2. key 在 Authorization: Bearer 里（不在 URL 路径里，也就没有 key 进日志那条泄漏面）；
3. 参考素材换到的是带签名的 URL，签名会过期——上传与提交必须连着做，绝不缓存 URL。

代理口径与本机 ComfyUI 相反：ComfyUI 是本机服务，必须绕开代理；云端是公网服务，
本机挂着 Clash/v2rayN 时不跟随代理反而连不上，所以默认 trust_env=True，按账号可切直连。
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

log = logging.getLogger("suxing_gallery.cloud")

UPLOAD_PATH = "/openapi/v2/media/upload/binary"
QUERY_PATH = "/openapi/v2/query"
PRICE_PATH_PREFIX = "/openapi/v2/price-preview/"
MODEL_PATH_PREFIX = "/openapi/v2/"
ACCOUNT_PATH = "/uc/openapi/accountStatus"

DEFAULT_TIMEOUT = 60.0
DOWNLOAD_TIMEOUT = 300.0
POLL_TIMEOUTS = {"image": 300.0, "audio": 300.0, "video": 1800.0}
RETRY_STATUS = {502, 503, 504}

DONE_STATES = {"SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED", "FAILED", "FAILURE", "ERROR", "TIMEOUT"}
RUNNING_WORDS = {"RUNNING", "QUEUED", "PENDING", "PROCESSING", "CREATED", "WAITING"}

# 错误码翻成人话。只收官方文档里确实给出的语义，其余一律带原文回给用户，不猜。
CODE_HINTS = {
    "401": "API Key 不对，或者已经被停用。去设置 → 模型API配置里重新填。",
    "403": "这个 Key 没有调用该模型的权限，或者账户欠费。",
    "404": "云端没有这个模型端点，通常是模型下线或改名了。",
    "429": "这家服务商的并发用满了，等一会儿再点。",
    "702": "余额不足，需要先去 RunningHub 充值。",
    "805": "任务被取消。",
}


class RunningHubError(RuntimeError):
    """面向用户的中文说明；status/code 留给上层判断要不要重试。"""

    def __init__(self, message: str, *, status: int | None = None, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = str(code or "")


def _short(text: Any, limit: int = 240) -> str:
    return " ".join(str(text if text is not None else "").split())[:limit]


def explain(status: int | None, code: str, message: str) -> str:
    """把状态码与错误码翻成一句人话，翻不出就回原文（原文比我们的猜测可信）。"""
    key = str(code or status or "")
    hint = CODE_HINTS.get(key)
    detail = _short(message)
    if hint and detail:
        return f"{hint}（云端原文：{detail}）"
    if hint:
        return hint
    if detail:
        return detail
    if status:
        return f"云端返回了 HTTP {status}，没有说明原因。"
    return "云端调用失败，没有说明原因。"


class RunningHubClient:
    """一个账号一个客户端；测试时用 transport 塞假服务，一次真网络都不发。"""

    def __init__(self, base_url: str, api_key: str, *, proxy_mode: str = "system",
                 transport: httpx.AsyncBaseTransport | None = None,
                 timeout: float = DEFAULT_TIMEOUT) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._api_key = api_key
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout,
            # 与 ComfyUIClient 相反的口径，理由在模块 docstring。
            trust_env=(proxy_mode != "direct"), transport=transport, follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # ---------- 底层 ----------

    async def _post(self, path: str, *, json_body: dict | None = None,
                    files: dict | None = None, timeout: float | None = None,
                    retries: int = 1) -> dict:
        last: Exception | None = None
        for attempt in range(retries + 1):
            try:
                response = await self._client.post(path, json=json_body, files=files,
                                                   timeout=timeout or self._client.timeout)
            except httpx.TimeoutException as exc:
                raise RunningHubError("云端超过 " + str(int((timeout or DEFAULT_TIMEOUT))) +
                                      " 秒没答话，可能是排队，也可能是本机网络不通。") from exc
            except httpx.HTTPError as exc:
                raise RunningHubError(
                    f"连不上云端（{exc.__class__.__name__}）。检查网络；如果这台机器挂着代理，"
                    "在设置里把这条账号的代理方式换成「直连」再试一次。") from exc
            if response.status_code in RETRY_STATUS and attempt < retries:
                last = RunningHubError(explain(response.status_code, "", ""))
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            return self._unwrap(response)
        raise last or RunningHubError("云端调用失败。")

    def _unwrap(self, response: httpx.Response) -> dict:
        text = response.text or ""
        try:
            payload = response.json()
        except ValueError:
            if response.status_code >= 400:
                raise RunningHubError(explain(response.status_code, "", text),
                                      status=response.status_code) from None
            raise RunningHubError("云端回的不是 JSON，接口可能改了。",
                                  status=response.status_code) from None
        if not isinstance(payload, dict):
            raise RunningHubError("云端回了一个没预料到的结构。", status=response.status_code)
        code = payload.get("code")
        failed = response.status_code >= 400 or (
            code not in (None, 0, "0") and payload.get("failed") is not False)
        if failed:
            raise RunningHubError(explain(response.status_code, str(code or ""),
                                          str(payload.get("message") or payload.get("msg") or "")),
                                  status=response.status_code, code=str(code or ""))
        if code in (0, "0") and isinstance(payload.get("data"), dict):
            return payload["data"]
        if code in (0, "0") and "data" in payload and not isinstance(payload.get("data"), dict):
            return {"value": payload.get("data")}
        return payload

    # ---------- 五个动作 ----------

    async def upload(self, filename: str, content: bytes,
                     content_type: str | None = None) -> str:
        """把参考素材传上去，拿回签名 URL。URL 会过期，所以拿到就要立刻用。"""
        files = {"file": (filename, content, content_type or "application/octet-stream")}
        data = await self._post(UPLOAD_PATH, files=files, timeout=180.0)
        url = str(data.get("download_url") or data.get("url") or "")
        if not url:
            raise RunningHubError("素材传上去了但没给回链接，这一条没法提交。")
        return url

    async def submit(self, path: str, body: dict) -> dict:
        """提交一次模型调用，回 {task_id, taskStatus}。"""
        payload = await self._post(path, json_body=body)
        task_id = str(payload.get("taskId") or payload.get("task_id") or payload.get("id") or "")
        if not task_id:
            raise RunningHubError(_short(payload.get("errorMessage") or payload.get("message"))
                                  or "云端没给任务号，这一条没提交成功。",
                                  code=str(payload.get("errorCode") or ""))
        return {"task_id": task_id, "raw": payload}

    async def query(self, task_id: str) -> dict:
        """查一次任务。回 {state, results, error, raw}，state ∈ waiting|running|done|failed。"""
        payload = await self._post(QUERY_PATH, json_body={"taskId": str(task_id)})
        status = str(payload.get("taskStatus") or payload.get("status") or "").upper()
        code = str(payload.get("errorCode") or "")
        if status in DONE_STATES and status not in {"SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED"}:
            return {"state": "failed", "results": [], "error": explain(None, code,
                                                                      str(payload.get("errorMessage") or "")),
                    "code": code, "raw": payload}
        if status in {"SUCCESS", "SUCCEED", "SUCCEEDED", "COMPLETED"}:
            return {"state": "done", "results": _results(payload), "error": "",
                    "code": code, "raw": payload}
        if status in RUNNING_WORDS or not status:
            return {"state": "running", "results": [], "error": "", "code": code, "raw": payload}
        return {"state": "running", "results": [], "error": "", "code": code, "raw": payload}

    async def wait(self, task_id: str, *, timeout: float, interval: float = 3.0,
                   on_tick=None) -> dict:
        """轮询到出结果。不给假进度，只把「已等待」交给 on_tick 说人话。"""
        import time

        started = time.time()
        while True:
            outcome = await self.query(task_id)
            if outcome["state"] in ("done", "failed"):
                return outcome
            if time.time() - started > timeout:
                raise RunningHubError(
                    f"云端跑了 {int(time.time() - started)} 秒还没出结果。任务可能还在排队，"
                    "关掉弹窗不会取消它，稍后可以在这里点「取回结果」。")
            if on_tick:
                await on_tick(time.time() - started)
            await asyncio.sleep(interval)

    async def estimate(self, path: str, body: dict) -> dict | None:
        """官方价格预估。拿不到就回 None——宁可不说价，也不自己乘一个假数。"""

        suffix = path[len(MODEL_PATH_PREFIX):] if path.startswith(MODEL_PATH_PREFIX) else path.lstrip("/")
        try:
            payload = await self._post(PRICE_PATH_PREFIX + suffix.lstrip("/"), json_body=body,
                                       retries=0)
        except RunningHubError:
            return None
        if not payload:
            return None
        return {"raw": payload}

    async def account_status(self) -> dict:
        """余额与并发。key 同时放 header 与 body：官方示例用的是 body 里的 apikey 字段。"""
        payload = await self._post(ACCOUNT_PATH, json_body={"apikey": self._api_key}, retries=0)
        coins = payload.get("remainCoins")
        try:
            coins_value = float(coins) if coins not in (None, "") else None
        except (TypeError, ValueError):
            coins_value = None
        counts = payload.get("currentTaskCounts")
        try:
            running = int(counts) if counts not in (None, "") else None
        except (TypeError, ValueError):
            running = None
        return {"remain_coins": coins_value, "running_tasks": running, "raw": payload}

    async def download(self, url: str) -> bytes:
        try:
            response = await self._client.get(url, timeout=DOWNLOAD_TIMEOUT)
        except httpx.HTTPError as exc:
            raise RunningHubError("产物下载失败，链接可能已经过期。点「取回结果」可以重新拿一份。") from exc
        if response.status_code >= 400:
            raise RunningHubError(f"产物下载失败（HTTP {response.status_code}），"
                                  "链接可能已经过期。点「取回结果」可以重新拿一份。",
                                  status=response.status_code)
        return response.content


def _results(payload: dict) -> list[dict]:
    raw = payload.get("results")
    if isinstance(raw, dict):
        raw = [raw]
    out: list[dict] = []
    for item in raw or []:
        if isinstance(item, str):
            out.append({"url": item, "output_type": ""})
        elif isinstance(item, dict):
            url = str(item.get("url") or item.get("fileUrl") or item.get("videoUrl") or "")
            if url:
                out.append({"url": url,
                            "output_type": str(item.get("outputType") or item.get("type") or "")})
    return out

