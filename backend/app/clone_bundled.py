"""内置的「一键同款」工作流：安装包自带图片、视频各一份，装完就有。

为什么槽位固化在资源文件里，而不是首次启动现检测：检测槽位要 ComfyUI 的
`object_info`，而首启时 ComfyUI 大概率还没开——那时候检测出来的模板会整族缺掉
比例/分辨率控件，用户拿到一条「能选、跑起来不对」的工作流（跟 PATCH 换工作流
那个静默降级的坑同源）。所以这里只装「在真机 ComfyUI 上已经检测准」的那份结果，
首启不联网、不猜参数。

三份东西说了算，都在 backend/app/bundled_workflows/*.json：
- `workflow`：ComfyUI 导出的 API 格式；
- `slots`：真机检测出来并 `normalize_slots` 过的槽位；
- `label` / `media_kind`：显示名与族别（图片 / 视频各有一个「当前」）。

更新与删除的规矩：
- 只在用户没动过它的时候随版本刷新（比对存的 workflow 与 `bundled_sha`）；
- 用户删掉的内置模板不会下次启动又长回来（记进 meta 的 dismissed 名单）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from .clone_templates import (
    MEDIA_KINDS,
    default_prompt_for,
    detect_media_kind,
    normalize_slots,
    parse_workflow,
    reference_cell_keys,
    reference_cells,
    wired_reference_soundtracks,
)

logger = logging.getLogger(__name__)

SEED_ENV = "SUXING_SEED_BUNDLED_TEMPLATES"
DISMISSED_META_KEY = "clone_bundled_templates_dismissed"
# 0.2.31 把「闪寻音频」一条拆成参考音色 / 指定音色 / 音色描述三条。
# 只有被拆过的那条需要放行：图片、视频、以及拆完新增的两条，删了就是用户本意。
SPLIT_RESCUE_KEYS = ("qwen3-tts-voice-clone",)
SPLIT_RESCUE_FLAG = "clone_bundled_split_rescued"
_DIR_NAME = "bundled_workflows"
_REQUIRED = ("key", "label", "media_kind", "workflow", "slots")


def seed_enabled() -> bool:
    """默认开；测试靠这个开关保持「新库默认没有内置模板」的老行为。"""
    raw = os.environ.get(SEED_ENV, "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def bundled_dir() -> Path:
    """找资源目录：开发期在包里，冻结后先 _MEIPASS/app，再 exe 同级。"""
    here = Path(__file__).resolve().parent / _DIR_NAME
    if here.is_dir():
        return here
    meipass = getattr(sys, "_MEIPASS", None)
    if isinstance(meipass, str) and meipass:
        alt = Path(meipass) / "app" / _DIR_NAME
        if alt.is_dir():
            return alt
    alt = Path(sys.executable).resolve().parent / "app" / _DIR_NAME
    if alt.is_dir():
        return alt
    return here


def workflow_sha(workflow: Any) -> str:
    """工作流正文的指纹。先解析再规范序列化，格式差异不会伪装成「用户改过」。"""
    try:
        nodes = parse_workflow(workflow)
        canonical = json.dumps(nodes, ensure_ascii=False, sort_keys=True)
    except ValueError:
        canonical = workflow if isinstance(workflow, str) else json.dumps(
            workflow, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def entries(directory: Path | None = None) -> list[dict]:
    """读内置模板，按 key 排序。少字段直接抛——那是我们打包出错，不该静默少一条。"""
    base = directory or bundled_dir()
    found: list[dict] = []
    for path in sorted(base.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"内置工作流 {path.name} 读不出来：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"内置工作流 {path.name} 不是对象")
        missing = [k for k in _REQUIRED if data.get(k) in (None, "", [], {})]
        if missing:
            raise ValueError(f"内置工作流 {path.name} 缺字段：{'、'.join(missing)}")
        data["_file"] = path.name
        found.append(data)
    return sorted(found, key=lambda one: str(one["key"]))


def dismissed(conn) -> set[str]:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (DISMISSED_META_KEY,)).fetchone()
    try:
        raw = json.loads(str(row["value"])) if row else []
    except (TypeError, ValueError):
        raw = []
    return {str(one) for one in raw} if isinstance(raw, list) else set()


def note_dismissal(conn, key: str) -> None:
    """用户删掉一条内置模板 → 记一笔，别下次启动又塞回去。"""
    if not key:
        return
    keys = dismissed(conn) | {str(key)}
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DISMISSED_META_KEY, json.dumps(sorted(keys), ensure_ascii=False)),
    )


def forgive_split_keys(conn) -> list[str]:
    """抹掉「拆分之前那次删除」留下的拉黑记录，返回这次放行的是哪几条。

    老库里删掉的是一条叫「闪寻音频」的声音工作流，拉黑记的名字却是拆完之后其中一条的
    key（qwen3-tts-voice-clone）。升级后 seed 照单全拒，三种出声方式凭空少一种、界面也
    不解释，用户只会以为是打包漏了。那次删除不可能是拒绝「参考音色」——它当时还不存在。

    只放行一次，旗标落库。不记旗标就是「放行 → 用户再删 → 名字回到名单 → 下次启动又放行」
    的无限复活，用户永远删不掉它（这条是测试先跑红才发现的）。
    代价：升级前一天刚删过参考音色的人会被放回一次，比让所有人少一种模式小得多。
    """
    if conn.execute("SELECT 1 FROM meta WHERE key=?", (SPLIT_RESCUE_FLAG,)).fetchone() is not None:
        return []
    gone = dismissed(conn)
    hit = set(SPLIT_RESCUE_KEYS)
    forgiven = sorted(gone & hit)
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (SPLIT_RESCUE_FLAG, "1"),
    )
    if forgiven:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (DISMISSED_META_KEY, json.dumps(sorted(gone - hit), ensure_ascii=False)),
        )
        logger.info("内置工作流放行：%s（拆分之前的删除不该吃掉新模式）", "、".join(forgiven))
    return forgiven


def cell_keys_of(template: dict) -> list[str]:
    """给测试用：这份工作流在弹窗里会摆出哪些参考格（含自动扩位）。"""
    _nodes, slots = _prepare(template)
    return reference_cell_keys(slots)


def _describe(key: str, nodes: dict, slots: list[dict]) -> str:
    cells = reference_cells(slots, wired_reference_soundtracks(nodes, slots))
    tally: dict[str, int] = {}
    for cell in cells:
        tally[str(cell.get("kind"))] = tally.get(str(cell.get("kind")), 0) + 1
    text = "/".join(f"{tally[k]}{k}" for k in ("image", "audio", "video") if tally.get(k))
    return f"{key}({text})" if text else key


def _names_of(item: dict) -> list[str]:
    """这份工作流可能被叫过的名字：现在的名字在前，历史名字在后。

    老库里躺着的大概率是导入时的文件名（`Qwen 多图编辑`、`H3参考视频`）。
    认领与改名都按这张表走，用户自己改过名的不会被顺手改掉。
    """
    out: list[str] = []
    for one in [item.get("label"), *(item.get("legacy_labels") or [])]:
        text = str(one or "").strip()
        if text and text not in out:
            out.append(text)
    return out


def _name_taken(conn, name: str, except_id: int | None = None) -> bool:
    sql = "SELECT 1 FROM clone_templates WHERE name=?"
    args: list[Any] = [name]
    if except_id is not None:
        sql += " AND id<>?"
        args.append(except_id)
    return conn.execute(sql, args).fetchone() is not None


def _adoptable_row(conn, names: list[str]):
    """按名字找一条还没认过主的旧记录（现在的名字优先，再认历史名字）。"""
    for name in names:
        row = conn.execute(
            "SELECT * FROM clone_templates WHERE bundled_key IS NULL AND name=? LIMIT 1",
            (name,),
        ).fetchone()
        if row is not None:
            return row
    return None


def seed(conn) -> dict:
    """把内置模板装进库。幂等：每启动一次跑一次也不会重复、不会覆盖用户的手改。"""
    # inserted 里带格子清单（h3-reference-video(9image/3audio/1video)），日志里一眼能核对
    summary = {"inserted": [], "updated": [], "adopted": [], "renamed": [],
               "skipped": [], "dismissed": [], "rescued": []}
    if not seed_enabled():
        return summary
    summary["rescued"] = forgive_split_keys(conn)
    gone = dismissed(conn)
    for item in entries():
        key = str(item["key"])
        if key in gone:
            summary["dismissed"].append(key)
            continue
        names = _names_of(item)
        label = names[0]
        sha = workflow_sha(item["workflow"])
        row = conn.execute(
            "SELECT * FROM clone_templates WHERE bundled_key=?", (key,)
        ).fetchone()
        if row is None:
            same_name = _adoptable_row(conn, names)
            if same_name is not None:
                # 用户早自己导入过同一份工作流：认下这条，不再造一条重名的。
                # bundled_sha 记的是安装包这版的指纹，跟他那份不一样就等于「他改过」，
                # 以后版本更新也不会把他的覆盖掉。
                adopt_id = int(same_name["id"])
                rename = str(same_name["name"]) != label and not _name_taken(conn, label, adopt_id)
                conn.execute(
                    "UPDATE clone_templates SET bundled_key=?, bundled_sha=?"
                    + (", name=?" if rename else "") + " WHERE id=?",
                    ((key, sha, label, adopt_id) if rename else (key, sha, adopt_id)),
                )
                summary["adopted"].append(key)
                if rename:
                    summary["renamed"].append(key)
                continue
            if _name_taken(conn, label):
                # 名字被别条占着（模板名有唯一索引），硬插会整条装载失败
                logger.warning("内置工作流 %s 没装：库里已经有一条叫「%s」的", key, label)
                summary["skipped"].append(key)
                continue
            nodes, slots = _prepare(item)
            kind = _kind_of(item, nodes)
            is_first = conn.execute(
                "SELECT 1 FROM clone_templates WHERE media_kind=? AND is_active=1", (kind,)
            ).fetchone() is None
            conn.execute(
                "INSERT INTO clone_templates(name, workflow, slots, default_prompt, is_active,"
                " media_kind, bundled_key, bundled_sha) VALUES(?,?,?,?,?,?,?,?)",
                (label, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
                 default_prompt_for(nodes, slots), 1 if is_first else 0, kind, key, sha),
            )
            summary["inserted"].append(_describe(key, nodes, slots))
            continue

        # 名字跟着包里的版本走：还叫历史名字（说明没人自己改过名）就顺势改成现在的名字
        if str(row["name"]) != label and str(row["name"]) in names[1:] \
                and not _name_taken(conn, label, int(row["id"])):
            conn.execute("UPDATE clone_templates SET name=? WHERE id=?", (label, int(row["id"])))
            summary["renamed"].append(key)

        stored_sha = str(row["bundled_sha"] or "")
        if stored_sha == sha:
            summary["skipped"].append(key)  # 版本没变
            continue
        if workflow_sha(row["workflow"]) != stored_sha:
            summary["skipped"].append(key)  # 用户改过（或改名前动过正文），不覆盖
            continue
        nodes, slots = _prepare(item)
        conn.execute(
            "UPDATE clone_templates SET workflow=?, slots=?, default_prompt=?, bundled_sha=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
             default_prompt_for(nodes, slots), sha, int(row["id"])),
        )
        summary["updated"].append(key)

    if summary["inserted"] or summary["updated"] or summary["adopted"] or summary["renamed"]:
        logger.info(
            "内置一键同款工作流：新增 %s，刷新 %s，认领同名 %s（改名 %s）",
            "、".join(summary["inserted"]) or "无",
            "、".join(summary["updated"]) or "无",
            "、".join(summary["adopted"]) or "无",
            "、".join(summary["renamed"]) or "无",
        )
    return summary


def _prepare(item: dict) -> tuple[dict, list[dict]]:
    """解析工作流并按内置槽位对齐；对不上就抛——内置文件坏了要吵，不能悄悄降级。"""
    nodes = parse_workflow(item["workflow"])
    slots = normalize_slots(item["slots"], nodes)
    if not [s for s in slots if s.get("kind") == "prompt"]:
        raise ValueError(f"内置工作流 {item.get('_file', item.get('key'))} 没有提示词槽位")
    return nodes, slots


def _kind_of(item: dict, nodes: dict) -> str:
    kind = str(item.get("media_kind") or "")
    return kind if kind in MEDIA_KINDS else detect_media_kind(nodes)
