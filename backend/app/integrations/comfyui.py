"""本机 ComfyUI 集成：探测运行状态 + 临时 workflow 文件落地。

设计目标：
- **零额外依赖**：探测只用标准库，扫端口只用系统自带的 ``netstat``，不引入 requests / psutil。
- **不执行 workflow**：仅提供「写到本地文件 + 复用 ComfyUI 标签页」的最小实现。
  ComfyUI 没有官方「加载但不执行」的 HTTP API；后续若要真一键，
  需要在 ComfyUI 端装扩展 / 写 litegraph.js loader，超出本仓库范围。
- **绝不走代理**：ComfyUI 是本机服务。浏览器会自动跳过 loopback，Python 不会——
  机器上挂着 Clash / v2rayN 之类的环境变量代理时，走代理的探测会把「ComfyUI 在跑」
  判成「没在跑」，表现就是「ComfyUI 自己打得开，图库说连不上」。所有请求一律关代理。
- **失败要说人话**：``probe_detail()`` 除了 bool 还带原因码
  （refused / timeout / http / dns / unreachable），前端能直接说「8188 上没有服务在监听」，
  而不是只丢一句「没连上」让用户猜。
- **能扫出真地址**：``scan_candidates()`` 只读**本机 loopback** 的监听端口，逐个认
  ``/system_stats``；换机器、换端口时在设置页一键采用，不用用户去猜端口。
  绝不扫局域网地址——那是对别人机器的端口扫描。
- **探测宽松**：依次尝试 ``/system_stats`` 与 ``/``，任一 2xx 即视为在跑。
  连接失败 / 超时 → 未运行（ComfyUI 没启动是正常状态，不抛错）。
- **文件命名用图片文件名**：避免所有 workflow 都叫 ``workflow.json`` / ``<id>.json``，
  冲突自动追加 ``_1`` / ``_2`` 后缀。
"""
from __future__ import annotations

import json
import re
import socket
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from ..config import data_dir


# ---------- 常量 ----------

DEFAULT_URL = "http://127.0.0.1:8188"
PROBE_PATHS = ("/system_stats", "/")
# 1.5s 是原来写死的值：冷启动、慢盘、Defender 首扫的机器上，在跑的 ComfyUI 会被判成没跑。
# 与 comfyui_client.probe 的 3s 对齐，两条链路别再一个快一个慢。
PROBE_TIMEOUT = 3.0
# 扫端口时单个端口的预算：宁可漏报一个候选，也不能把设置页卡十几秒。
SCAN_TIMEOUT = 1.2
SCAN_WORKERS = 12
SCAN_MAX_TARGETS = 80
SCAN_MAX_FOUND = 12
# 常见 ComfyUI 端口：8188 是默认，8000 是官方桌面版，其余是整合包常改的。
COMFYUI_COMMON_PORTS = (8188, 8189, 8187, 8000, 8080, 8888)
# 只认这几种 loopback 写法，其余（192.168.x.x 等）一律不探。
_LOOPBACK_V4 = {"127.0.0.1", "0.0.0.0", "localhost"}
_LOOPBACK_V6 = {"::1", "::", "[::1]", "[::]"}


# ---------- 不走代理的 opener ----------

_OPENER: urllib.request.OpenerDirector | None = None


def no_proxy_opener() -> urllib.request.OpenerDirector:
    """给本机 ComfyUI 用的 opener：代理表是空的，环境变量与注册表代理都不认。"""
    global _OPENER
    if _OPENER is None:
        _OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return _OPENER


def _open(url: str, timeout: float):
    """发一个 GET。单独抽出来是为了给测试一个不用起真服务的替换点。"""
    request = urllib.request.Request(url, method="GET")
    return no_proxy_opener().open(request, timeout=timeout)


# ---------- 失败原因 ----------


@dataclass(frozen=True)
class ProbeResult:
    """一次探测的结果。``running`` 为假时 ``reason`` 一定是能给人看的一句中文。"""

    running: bool
    reason: str = ""
    reason_code: str = ""


def host_label(url: str) -> str:
    """把 URL 收成「host:port」，出错信息里要说清楚是拨的哪儿。"""
    parts = urllib.parse.urlsplit(url or "")
    host = parts.hostname or (url or "")
    try:
        port = parts.port
    except ValueError:
        port = None
    return f"{host}:{port}" if port else host


def classify_error(exc: Exception, url: str, timeout: float) -> tuple[str, str]:
    """异常 → (原因码, 人话)。原因码是给前端分分支用的，人是给苏醒看的。"""
    where = host_label(url)
    if isinstance(exc, urllib.error.HTTPError):
        return "http", f"{where} 有响应，但返回了 HTTP {exc.code}，不像 ComfyUI"
    inner = getattr(exc, "reason", None) if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(inner, ConnectionRefusedError):
        return "refused", f"{where} 上没有服务在监听"
    if isinstance(inner, (TimeoutError, socket.timeout)) or isinstance(exc, (TimeoutError, socket.timeout)):
        return "timeout", f"{where} 超过 {timeout:g} 秒没回话"
    if isinstance(inner, socket.gaierror) or isinstance(exc, socket.gaierror):
        return "dns", f"地址 {where} 解析不了"
    detail = " ".join(str(inner or exc).split())[:120]
    return "unreachable", f"连不上 {where}：{detail}" if detail else f"连不上 {where}"


# ---------- 探测 ----------


def probe_detail(url: str = DEFAULT_URL, timeout: float | None = None) -> ProbeResult:
    """探测本机 ComfyUI，并说清「没连上」到底是怎么个没连上。

    任一探测路径拿到 2xx 就算在跑。任何异常都不抛到调用方。
    """
    base = (url or "").rstrip("/") or DEFAULT_URL
    secs = PROBE_TIMEOUT if timeout is None else timeout
    code, reason = "unreachable", f"{host_label(base)} 上没有服务在监听"
    for path in PROBE_PATHS:
        try:
            with _open(base + path, timeout=secs) as resp:
                status = int(getattr(resp, "status", 200) or 200)
            if 200 <= status < 300:
                return ProbeResult(True)
            code, reason = "http", f"{host_label(base)} 有响应，但返回了 HTTP {status}，不像 ComfyUI"
        except Exception as exc:  # noqa: BLE001 - 连不上是常态，翻成人话就行
            code, reason = classify_error(exc, base, secs)
    return ProbeResult(False, reason, code)


def probe(url: str = DEFAULT_URL) -> bool:
    """只看「在不在跑」。要原因请用 :func:`probe_detail`。"""
    return probe_detail(url).running


def system_stats(url: str, timeout: float | None = None) -> dict | None:
    """取 ``/system_stats`` 的 JSON。这个端点是 ComfyUI 独有的，认到就算认出。"""
    base = (url or "").rstrip("/") or DEFAULT_URL
    secs = PROBE_TIMEOUT if timeout is None else timeout
    try:
        with _open(base + "/system_stats", timeout=secs) as resp:
            if not 200 <= int(getattr(resp, "status", 200) or 200) < 300:
                return None
            raw = resp.read()
    except Exception:  # noqa: BLE001 - 扫描时的失败是预期内的，静默跳过
        return None
    try:
        data = json.loads(raw.decode("utf-8", "ignore"))
    except (ValueError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def comfyui_version(url: str) -> str:
    """认出是 ComfyUI 时给版本号，认不出给空串。"""
    stats = system_stats(url)
    if not stats:
        return ""
    info = stats.get("system")
    if isinstance(info, dict) and info.get("comfyui_version"):
        return str(info["comfyui_version"])
    return "已认出"


# ---------- 扫本机在跑的 ComfyUI ----------


def parse_netstat_listeners(text: str) -> list[tuple[str, int]]:
    """从 ``netstat -ano -p TCP`` 的文本里挑出 loopback 的 LISTENING 端口。

    纯函数，方便拿一段固定文本测。返回的是 (原始地址, 端口)，地址原样留着，
    由 :func:`url_for` 决定往哪个地址上拨。
    """
    found: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for line in (text or "").splitlines():
        cols = line.split()
        if len(cols) < 4 or cols[0].upper() != "TCP":
            continue
        if "LISTENING" not in line.upper():
            continue
        local = cols[1]
        host, _, port_text = local.rpartition(":")
        if not port_text.isdigit():
            continue
        port = int(port_text)
        if not (1 <= port <= 65535):
            continue
        if host not in _LOOPBACK_V4 and host not in _LOOPBACK_V6:
            continue  # 局域网/公网地址上的服务不探：那不是本机 ComfyUI，那是扫描别人
        if (host, port) in seen:
            continue
        seen.add((host, port))
        found.append((host, port))
    return found


def loopback_listeners() -> list[tuple[str, int]]:
    """本机正在监听的 loopback 端口。netstat 用不了就返回空（调用方还有常见端口兜底）。"""
    try:
        done = subprocess.run(  # noqa: S603 - 固定命令名与固定参数，不接受外部输入
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            timeout=8.0,
            check=False,
        )
        text = (done.stdout or b"").decode("utf-8", "ignore")
        if not text.strip():
            text = (done.stdout or b"").decode("gbk", "ignore")
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_netstat_listeners(text)


def url_for(host: str, port: int) -> str:
    """监听地址 → 可拨的 URL。IPv6 必须带方括号，0.0.0.0 要换成 127.0.0.1 才拨得动。"""
    if host in _LOOPBACK_V6:
        return f"http://[::1]:{port}"
    if host == "0.0.0.0":
        return f"http://127.0.0.1:{port}"
    return f"http://{host}:{port}"


def scan_candidates(exclude_url: str = "") -> list[dict]:
    """找出这台机器上真正在跑的 ComfyUI，返回 ``[{url, version}]``。

    先扫 netstat 报出来的 loopback 监听端口（这样换端口、只绑 IPv6 都能认出来），
    再用常见端口兜底（netstat 不可用时）。只探 loopback，绝不碰局域网。
    """
    targets: list[str] = []
    seen: set[str] = set()

    def _add(url: str) -> None:
        if url in seen or len(targets) >= SCAN_MAX_TARGETS:
            return
        seen.add(url)
        targets.append(url)

    for host, port in loopback_listeners():
        _add(url_for(host, port))
    for port in COMFYUI_COMMON_PORTS:
        _add(f"http://127.0.0.1:{port}")

    skip = exclude_url.rstrip("/")
    targets = [u for u in targets if u.rstrip("/") != skip]
    if not targets:
        return []

    def _check(url: str) -> dict | None:
        version = comfyui_version(url)
        return {"url": url, "version": version} if version else None

    found: list[dict] = []
    with ThreadPoolExecutor(max_workers=SCAN_WORKERS) as pool:
        for item in pool.map(_check, targets):
            if item:
                found.append(item)
            if len(found) >= SCAN_MAX_FOUND:
                break
    # 常见端口排前面：用户认得的 8188 比一个随机高位端口更像「就是它」
    found.sort(key=lambda item: (_port_of(item["url"]) not in COMFYUI_COMMON_PORTS,
                                 _port_of(item["url"]), item["url"]))
    return found


def _port_of(url: str) -> int:
    try:
        return int(urllib.parse.urlsplit(url).port or 0)
    except (ValueError, TypeError):
        return 0


# ---------- 临时文件 ----------

# Windows / POSIX 文件系统都不允许的字符（含控制字符），统一替换为下划线。
_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_MAX_NAME_LEN = 100  # 限长，避免超长文件名 / 超长路径


def comfyui_temp_dir() -> Path:
    p = data_dir() / "comfyui_temp"
    p.mkdir(parents=True, exist_ok=True)
    return p


def sanitize_filename(raw: str) -> str:
    r"""把图片原始文件名清洗成可作 JSON 文件名的安全短名。

    - 把文件系统非法字符（含 ``/`` ``\`` ``:`` 等）替换为 ``_``
    - 去掉扩展名（统一追加 .json）
    - 限长 ``_MAX_NAME_LEN``，空字符串 / 纯符号兜底为 ``workflow``

    注意：不直接用 ``Path(raw).name`` / ``Path(raw).stem``，
    Windows 上 ``:`` 是盘符分隔符，会把前缀吞掉（``Path("a:b.png").name`` = ``"b.png"``）。
    而且 ``\`` / ``/`` 在文件名字符串里出现时也应作为非法字符处理，
    而不是当成目录分隔符。
    """
    if not raw:
        return "workflow"
    sanitized = _UNSAFE_CHARS.sub("_", raw)
    base = sanitized.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." in base:
        base = base.rsplit(".", 1)[0]
    stem = base.strip(" ._") or "workflow"
    return stem[:_MAX_NAME_LEN]


def _unique_path(target_dir: Path, stem: str) -> Path:
    """在 ``target_dir`` 下找一个不与现有文件冲突的 ``<stem>[_N].json`` 路径。

    优先 ``<stem>.json``，冲突则 ``<stem>_1.json``、``<stem>_2.json`` …
    """
    candidate = target_dir / f"{stem}.json"
    if not candidate.exists():
        return candidate
    counter = 1
    while counter < 10000:
        candidate = target_dir / f"{stem}_{counter}.json"
        if not candidate.exists():
            return candidate
        counter += 1
    # 兜底：永远不应该到这里；保护一下不返回会被覆盖的路径
    raise RuntimeError(f"too many collisions for stem={stem!r}")


def write_workflow_temp(image_filename: str, workflow_json: str) -> Path | None:
    """把 workflow JSON 写到 ``data/comfyui_temp/<sanitized>.json``。

    文件名取自图片原始 filename（去扩展名、清洗非法字符）。
    冲突时自动追加 ``_1`` / ``_2`` 后缀。``workflow_json`` 为空或 None 时返回 None。
    """
    if not workflow_json or not workflow_json.strip():
        return None
    stem = sanitize_filename(image_filename)
    target = _unique_path(comfyui_temp_dir(), stem)
    target.write_text(workflow_json, encoding="utf-8")
    return target