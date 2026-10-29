"""一键同款的来源：这张生成图当初喂了哪几张参考图。

为什么要有这件事：参考图数量本身就是这张图的一部分——用两张参考做出来的画面，点
「一键同款」就该看到当初那两张，不然「同款」只剩提示词同款，用户得自己回忆喂了什么。

来源有两条路，读的时候两条都走：

1. 生成当时写进 `clone_sources`（`clone_jobs` 在成图认领进库、广播「已完成」之前写）。
   这条最准，还顺手记住了用的哪条工作流、当初点的是哪张图。
2. 从成图自己的 ComfyUI `prompt` tEXt 里认回来。图片其实说得出这件事：推进 ComfyUI 的
   参考图文件名叫 `seekx_ref_<图库id>_<内容sha1前8位>.png`，id 给线索、hash 给证据。
   只要节点输入里那个名字还在，就能认出当初那几张——旧库没记上的、生成时写库没跑到的、
   换数据目录重扫把 id 打乱的，都还有救。

hash 必须核：id 会随重扫重排，光认 id 会把别的图说成当初的参考图。核不上就宁可不算这一张
（计入 dropped，让弹窗明说少了几张），也不能认错。写库那条也一样认 path 优先、id 兜底。

读的时候不回写库：一次解析加两次 hash 只是几毫秒，换来的是「来源永远和文件一致」——
把推导结果钉进库里，哪天文件变了反而会被旧记录盖住。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from pathlib import Path
from typing import Any

from .db import get_pool
from .parser import _is_link, _read_png_chunks
from .repository import image_summary

log = logging.getLogger("suxing_gallery.clone")

# 列名叫 refs：references 是 SQL 关键字，原样当列名建表直接语法错误。
SCHEMA = """
CREATE TABLE IF NOT EXISTS clone_sources (
    image_id INTEGER PRIMARY KEY,
    template_id INTEGER,
    source_image_id INTEGER,
    refs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""

# 成图里认参考图用的上传名（见 clone_jobs._upload_reference）
_REF_NAME = re.compile(r"seekx_ref_(\d+)_([0-9a-f]{8})")
# 超过这个体积不核 hash：来源只是省一次重新选图，不该把开弹窗变成读几十兆
_MAX_HASH_BYTES = 128 * 1024 * 1024
# autogrow 的输入名：images.image_2 里那个 2 决定它排在参考位的第几格
_GROW_NAME = re.compile(r"^(?P<stem>.+)_(?P<index>\d+)$")


def initialize(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def _ref_snapshot(image_id: int) -> dict[str, Any] | None:
    """记下参考图当时的身份：id 会重排，path 和 filename 才是能拿来对的东西。"""
    row = get_pool().main().execute(
        "SELECT id, path, filename FROM images WHERE id=?", (image_id,)
    ).fetchone()
    if row is None:
        return None
    return {"image_id": int(row["id"]), "path": str(row["path"]), "filename": str(row["filename"])}


def record(
    *,
    image_ids: list[int],
    template_id: int | None,
    source_image_id: int | None,
    references: list[dict],
) -> int:
    """把这一批成图的来源写进库，返回写了几条。

    一次产出多张时它们共用同一套参考图，所以每条成图各存一份，读的时候不必再回溯
    「是哪次任务」。同一张成图重复登记（被重新认领）按覆盖处理。
    """
    snapshot: list[dict[str, Any]] = []
    for ref in references:
        try:
            ref_id = int(ref.get("image_id") or 0)
        except (TypeError, ValueError):
            continue
        if ref_id <= 0:
            continue
        got = _ref_snapshot(ref_id)
        if got is None:
            continue
        slot = str(ref.get("slot") or "")
        if slot:
            got["slot"] = slot
        snapshot.append(got)
    if not image_ids or not snapshot:
        return 0
    conn = get_pool().main()
    payload = json.dumps(snapshot, ensure_ascii=False)
    written = 0
    for image_id in image_ids:
        try:
            out_id = int(image_id)
        except (TypeError, ValueError):
            continue
        if out_id <= 0:
            continue
        conn.execute(
            "INSERT INTO clone_sources(image_id, template_id, source_image_id, refs)"
            " VALUES(?,?,?,?)"
            " ON CONFLICT(image_id) DO UPDATE SET"
            " template_id=excluded.template_id,"
            " source_image_id=excluded.source_image_id,"
            " refs=excluded.refs",
            (out_id, template_id, source_image_id, payload),
        )
        written += 1
    conn.commit()
    return written


def lookup(image_id: int) -> dict[str, Any]:
    """这张图的来源：{references, dropped, template_id, source_image_id, origin}。

    origin 说清这份来源是怎么来的，前端据此决定要不要跟用户解释：
      db         生成当时记下的
      file       从成图自己的 workflow 里认回来的
      unrecorded 这张是 AI 出的图，但参考图认不出来（多半不是在本机库外面跑的）
      ""         说不清（不是 PNG、没带 workflow、或压根是张导入的照片）
    库里那条能认出参考图就用它（它还知道工作流和当初点的那张）；一条都没认出来才退回读文件，
    这样换数据目录重扫把 path 全弄断的库也有第二次机会。
    """
    row = get_pool().main().execute(
        "SELECT template_id, source_image_id, refs FROM clone_sources WHERE image_id=?",
        (image_id,),
    ).fetchone()
    origin = ""
    refs: list[dict[str, Any]] = []
    dropped = 0
    template_id = row["template_id"] if row else None
    source_image_id = row["source_image_id"] if row else None
    if row is not None:
        refs, dropped = _from_row(row["refs"])
        if refs:
            origin = "db"
    if not refs:
        file_refs, file_dropped, has_workflow = _from_file(image_id)
        if file_refs:
            refs, dropped = file_refs, file_dropped
            origin = "file"
        elif has_workflow:
            dropped = max(dropped, file_dropped)
            origin = "unrecorded"
    return {
        "template_id": template_id,
        "source_image_id": source_image_id,
        "references": refs,
        "dropped": dropped,
        "origin": origin,
    }


def _from_row(raw: Any) -> tuple[list[dict[str, Any]], int]:
    """库里记的那份：先认 path，认不到再认 id。认不出来的计入 dropped。"""
    try:
        saved = json.loads(raw or "[]")
    except (TypeError, ValueError):
        saved = []
    refs: list[dict[str, Any]] = []
    dropped = 0
    for item in saved if isinstance(saved, list) else []:
        found = _resolve(item)
        if found is None:
            dropped += 1
            continue
        refs.append(found)
    return refs, dropped


def _resolve(item: Any) -> dict[str, Any] | None:
    """先认 path，认不到再认 id（还要求文件名也对得上）。参考图保持登记时的顺序。"""
    if not isinstance(item, dict):
        return None
    slot = str(item.get("slot") or "")
    path = str(item.get("path") or "")
    if path:
        found = image_summary(path=path)
        if found:
            return _with_slot(found, slot)
    try:
        image_id = int(item.get("image_id") or 0)
    except (TypeError, ValueError):
        return None
    if image_id <= 0:
        return None
    found = image_summary(image_id=image_id)
    if not found:
        return None
    # path 已经变了、只剩 id：这时 id 很可能指向另一张图，文件名也对不上就放弃。
    if str(item.get("filename") or "") != str(found.get("filename") or ""):
        return None
    return _with_slot(found, slot)


def _with_slot(summary: dict[str, Any], slot: str) -> dict[str, Any]:
    """把当初的参考位键一起带回前端：画面上是「图片几」由模板现算，但接线位置是历史事实。"""
    if slot:
        summary["slot"] = slot
    return summary

# ---------- 从成图自己的 workflow 里认回参考图 ----------


def _png_prompt(path: Path) -> dict[str, Any] | None:
    """成图里的 ComfyUI prompt JSON（API 格式）。不是 PNG、没带 chunk、JSON 坏了都算没有。"""
    if path.suffix.lower() != ".png":
        return None
    try:
        raw = _read_png_chunks(path).get("prompt")
    except (OSError, ValueError):
        return None
    if not raw:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    try:
        obj = json.loads(raw)
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _link_source(value: Any) -> str:
    """输入值是个接线就返回上游节点号，否则空字符串。"""
    if not _is_link(value):
        return ""
    try:
        return str(int(float(str(value[0]))))
    except (TypeError, ValueError, IndexError):
        return ""


def _ref_order(node: str, feeds: dict[str, list[tuple[str, str]]]) -> tuple[int, int, int]:
    """这张参考图该排在参考位的第几格：先工作流自带的 LoadImage，再是长出来的格子。

    分不清就得看接线。多喂一张参考图时，后端是现加一个 LoadImage 节点接到
    `582.images.image_2` 上（节点号每次生成都不一样），所以「喂的是第几个输入」
    才是它当初站在第几格的证据：`image_1`／不带序号的是自带的那格，
    `image_N`（N≥2）是长出来的第 N 格。
    """
    node_no = int(node) if node.isdigit() else 0
    for consumer, key in feeds.get(node, []):
        name = str(key).rpartition(".")[2] or str(key)
        grown = _GROW_NAME.match(name)
        consumer_no = int(consumer) if consumer.isdigit() else 0
        if grown and int(grown.group("index")) >= 2:
            return (1, consumer_no, int(grown.group("index")))
        return (0, consumer_no, 0)
    # 没人接（被摘掉参考链了）：按节点号排，至少不比原来的顺序更差
    return (0, node_no, 0)


def _prompt_references(prompt: dict[str, Any]) -> list[dict[str, Any]]:
    """按参考位顺序挑出成图里用过的参考图：[{image_id, digest}]。

    只认 `seekx_ref_<id>_<hash>` 这种一键同款自己的上传名——用户工作流里的别的图
    （底图、LoRA 示例图）不该被说成「当初的参考图」。
    """
    nodes = {str(nid): node for nid, node in prompt.items() if isinstance(node, dict)}
    feeds: dict[str, list[tuple[str, str]]] = {}
    for nid, node in nodes.items():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, value in inputs.items():
            src = _link_source(value)
            if src:
                feeds.setdefault(src, []).append((nid, str(key)))
    found: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
    for nid, node in nodes.items():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, value in inputs.items():
            if not isinstance(value, str):
                continue
            hit = _REF_NAME.search(value.rsplit("/", 1)[-1])
            if not hit:
                continue
            found.append((_ref_order(nid, feeds),
                          {"image_id": int(hit.group(1)), "digest": hit.group(2)}))
    found.sort(key=lambda item: item[0])
    return [item[1] for item in found]


def _verified(entry: dict[str, Any]) -> dict[str, Any] | None:
    """按上传名里的 id 找到图，再用内容 hash 验一遍。认不出或验不过都返回 None。

    hash 是这道工序的全部底气：图库换目录重扫会把 id 整个重排，光认 id 就会指着
    一张没喂过的图说「这是你当初的图片2」。验不过宁可少一张（记 dropped）。
    """
    row = get_pool().main().execute(
        "SELECT path FROM images WHERE id=?", (entry["image_id"],)
    ).fetchone()
    if row is None:
        return None
    path = Path(str(row["path"]))
    try:
        if path.stat().st_size > _MAX_HASH_BYTES:
            return None
        content = path.read_bytes()
    except OSError:
        return None
    if hashlib.sha1(content).hexdigest()[:8] != entry["digest"]:
        return None
    return image_summary(image_id=int(entry["image_id"]))


def _from_file(image_id: int) -> tuple[list[dict[str, Any]], int, bool]:
    """读成图自己的 workflow 认参考图：(参考图, 认不出的张数, 这张图带没带 workflow)。

    这里故意不带 slot 键。多喂一张参考图时后端是临时新加一个 LoadImage 节点，
    节点号每次生成都在变，从成图反推「它对应模板里哪个参考位」在多图工作流上会猜错；
    顺序（上面那套接线判序）是可靠的，交给前端按格子顺序摆就够了。库里记的那份才有 slot。
    """
    row = get_pool().main().execute(
        "SELECT path, kind FROM images WHERE id=?", (image_id,)
    ).fetchone()
    if row is None or str(row["kind"] or "image") != "image":
        return [], 0, False
    prompt = _png_prompt(Path(str(row["path"])))
    if prompt is None:
        return [], 0, False
    refs: list[dict[str, Any]] = []
    dropped = 0
    for entry in _prompt_references(prompt):
        found = _verified(entry)
        if found is None:
            dropped += 1
            continue
        refs.append(found)
    return refs, dropped, True
