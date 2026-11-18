"""内置的「再次创作」工作流：安装包自带图片、视频各一份，装完就有。

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
- **槽位约定变了也要刷新**：`bundled_sha` 只按 workflow 算，所以「只改槽位、正文一字没动」
  的那一版（给某格加遮罩标记、撤掉一条多余的输入框都算）光比 sha 会被当成没变，
  用户库里永远留着旧约定。所以正文没被改过时，还要再比一次槽位。
- 用户删掉的内置模板不会下次启动又长回来（记进 meta 的 dismissed 名单）。
- `prefer_active: true` 的那条第一次装进库时顶掉同族原先的「当前」，
  老那条留在库里不再当前，用户随时能在菜单里切回去；之后不再抢（见 seed）。
- **冻住的那条，随包后来修过的单个字段照样要送到**：同名认领时 `bundled_sha` 记的是
  安装包那版的指纹，于是「他自己导入的那份从一开始就和包里的不一样」跟「他后来动过正文」
  长得一模一样，seed 只能整条不覆盖。正文不覆盖是对的（那是他的资产），
  代价是那一个字段也跟着卡死。登记在 `STALE_FIELD_FIXES` 里的，装载时按值定点补一次
  （`_stale_field_repairs`），和 `clone_templates.migrate_slot_multiples` 是同一个思路。
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

# 随包正文后来修过的某一个个字段，遇到被「用户改过」冻住的那条就永远送不进去（原因见文件头）。
# 登记在这里的字段，装载时定点补一次。条件写得很窄，宁可漏补不可错补：
# 这条 key 的这颗节点还在、类别还是登记的那个、这个输入还在、而且值**正好是当年那个旧值**。
# 只要他自己拧过（值不等于旧值），一个字都不动。随包正文以后改了目标值，这条登记就得跟着
# 删或改，有一条测试专门盯这件事。
STALE_FIELD_FIXES: tuple[dict, ...] = (
    {
        "key": "h3-reference-video",   # 老版参考生视频（后继是 h3-reference-video-v2）
        "node": "185",                 # 参考视频载入，喂 ref_video_0，也就是模型眼里的 <Video 1>
        "class_type": "VHS_LoadVideo",
        "input": "force_rate",
        "stale": 0,                    # 0 = 按参考片自己的帧率载入（他当年导入的那份就是这个）
        "fixed": 24,                   # 随包两版（这一版和 v2 的三台载入）一律 24
        "why": "参考视频按原生帧率载入，与随包两版一律 24 的口径不一致",
    },
)


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


def _set_dismissed(conn, keys: set[str]) -> None:
    """拉黑名单整体覆写。记删除、恢复、拆分放行三处都写它，共用一份。"""
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DISMISSED_META_KEY, json.dumps(sorted(str(k) for k in keys), ensure_ascii=False)),
    )


def note_dismissal(conn, key: str) -> None:
    """用户删掉一条内置模板 → 记一笔，别下次启动又塞回去。"""
    if not key:
        return
    _set_dismissed(conn, dismissed(conn) | {str(key)})


class RestoreBlocked(ValueError):
    """恢复被挡住的具体原因。路由层照它决定 409 说什么话。"""


def hidden_templates() -> list[dict]:
    """被删掉、因此不再自动装载的内置工作流（设置页列出来，附一颗恢复）。

    这条接口存在的理由：以前删内置工作流是单向门，名单既看不见也没有反悔，
    删错只能进库改。随包清单读不出来时返回空表 → 设置页顶多少一颗恢复按钮，
    不该把整页拖崩。
    """
    from .db import get_pool

    conn = get_pool().main()
    gone = dismissed(conn)
    if not gone:
        return []
    try:
        catalog = entries()
    except ValueError as exc:
        logger.warning("随包工作流清单读不出来，隐藏列表先空着：%s", exc)
        return []
    alive = {str(r[0]) for r in conn.execute(
        "SELECT bundled_key FROM clone_templates WHERE bundled_key IS NOT NULL")}
    return [{"key": str(item["key"]), "name": str(item["label"]),
             "media_kind": str(item["media_kind"])}
            for item in catalog
            if str(item["key"]) in gone and str(item["key"]) not in alive]


def restore(key: str) -> dict:
    """恢复一条被删掉的内置工作流：先从拉黑名单摘掉名字，再走一次装载。

    走的是和首次装载同一条路（seed），不另开一套插入逻辑，所以槽位、默认台词、
    「同族没有当前才当当前」这些规矩只有一份。
    """
    from .db import get_pool

    conn = get_pool().main()
    clean = str(key or "").strip()
    if clean not in dismissed(conn):
        raise KeyError("这一条不在已隐藏的内置工作流里，可能没删过，也可能已经恢复过了。")
    catalog = {str(item["key"]): item for item in entries()}
    if clean not in catalog:
        # 新版安装包已经不带这条了：顺手把死名字从名单里清掉，别让它永远占着
        _set_dismissed(conn, dismissed(conn) - {clean})
        raise RestoreBlocked("这一条新版安装包已经不带了，名单里的记录顺手清掉了。")
    _set_dismissed(conn, dismissed(conn) - {clean})
    seed(conn)
    row = conn.execute("SELECT id FROM clone_templates WHERE bundled_key=?", (clean,)).fetchone()
    if row is None:
        # 模板名有唯一索引，名字被别条占着就装不进来。要说清楚下一步做什么。
        raise RestoreBlocked("库里已经有一条同名的工作流了，先给它改个名再恢复。")
    return {"id": int(row["id"]), "name": str(catalog[clean]["label"])}


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
        _set_dismissed(conn, gone - hit)
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


def _stale_field_repairs(key: str, nodes: dict) -> list[str]:
    """按 STALE_FIELD_FIXES 补这份工作流里「包里早改了、库里还停在当年那个值」的字段。

    只动点名的那一个输入，且只在它仍等于旧值时动。返回改动的说明，空表表示一个字没动。
    节点号还在但类别已经不是登记的那个也跳过：那颗节点已经不是当年那颗，不能拿号当身份。
    """
    done: list[str] = []
    for fix in STALE_FIELD_FIXES:
        if str(fix["key"]) != str(key):
            continue
        node = nodes.get(str(fix["node"]))
        if not isinstance(node, dict):
            continue
        if str(node.get("class_type") or node.get("_class_type") or "") != str(fix["class_type"]):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or fix["input"] not in inputs:
            continue
        if inputs[fix["input"]] != fix["stale"]:
            continue  # 不是当年那个旧值 = 他自己拧过，不碰
        inputs[fix["input"]] = fix["fixed"]
        done.append(f'{fix["key"]} 节点{fix["node"]}.{fix["input"]}：'
                    f'{fix["stale"]}→{fix["fixed"]}（{fix["why"]}）')
    return done


def _repair_stale_fields(conn, template_id: int, key: str, stored_workflow: Any) -> list[str]:
    """在「正文不覆盖」那条路上定点补登记过的字段，返回补了什么的说明。

    补完这条仍然算用户改过：bundled_sha 不动，下次启动正文照旧整条冻着；而这个字段
    已经不是旧值，再启动也不会重复写。正文读不出来只吵日志——不能因为一次字段修正
    把整条装载带崩（建库那条路整个包在 try 里）。
    """
    try:
        nodes = parse_workflow(stored_workflow)
    except ValueError as exc:
        logger.info("内置工作流 %s 的正文读不出来，登记过的字段修正先跳过：%s", key, exc)
        return []
    done = _stale_field_repairs(key, nodes)
    if done:
        conn.execute("UPDATE clone_templates SET workflow=? WHERE id=?",
                     (json.dumps(nodes, ensure_ascii=False), template_id))
        logger.info("内置工作流字段修正：%s", "；".join(done))
    return done


def seed(conn) -> dict:
    """把内置模板装进库。幂等：每启动一次跑一次也不会重复、不会覆盖用户的手改。"""
    # inserted 里带格子清单（h3-reference-video(9image/3audio/1video)），日志里一眼能核对
    summary = {"inserted": [], "updated": [], "adopted": [], "renamed": [],
               "skipped": [], "dismissed": [], "rescued": [], "repaired": []}
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
                # 认领完就地补一次登记过的字段：他那份是当年自己导的，
                # 不必等下一次启动才收到包里早就有的那个修正
                summary["repaired"] += _repair_stale_fields(
                    conn, adopt_id, key, same_name["workflow"])
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
            cursor = conn.execute(
                "INSERT INTO clone_templates(name, workflow, slots, default_prompt, is_active,"
                " media_kind, bundled_key, bundled_sha) VALUES(?,?,?,?,?,?,?,?)",
                (label, json.dumps(nodes, ensure_ascii=False), json.dumps(slots, ensure_ascii=False),
                 default_prompt_for(nodes, slots), 1 if is_first else 0, kind, key, sha),
            )
            if item.get("prefer_active"):
                # 包里点名这一条是新的当前（一条工作流被它的后继取代）。只在这个 key
                # 第一次进库时顶一次，同族原先那条摘下来留在库里——菜单里切得回去。
                # 不做「每次启动都抢回来」：用户之后自己选了别的，那是他的选择。
                new_id = int(cursor.lastrowid or 0)
                conn.execute("UPDATE clone_templates SET is_active=0 WHERE media_kind=? AND id<>?",
                             (kind, new_id))
                conn.execute("UPDATE clone_templates SET is_active=1 WHERE id=?", (new_id,))
            summary["inserted"].append(_describe(key, nodes, slots))
            continue

        # 名字跟着包里的版本走：还叫历史名字（说明没人自己改过名）就顺势改成现在的名字
        if str(row["name"]) != label and str(row["name"]) in names[1:] \
                and not _name_taken(conn, label, int(row["id"])):
            conn.execute("UPDATE clone_templates SET name=? WHERE id=?", (label, int(row["id"])))
            summary["renamed"].append(key)

        stored_sha = str(row["bundled_sha"] or "")
        if workflow_sha(row["workflow"]) != stored_sha:
            summary["skipped"].append(key)  # 用户改过（或改名前动过正文），不覆盖
            # 整条不覆盖，不等于那一个字段就该永远停在当年：登记过的定点补
            summary["repaired"] += _repair_stale_fields(
                conn, int(row["id"]), key, row["workflow"])
            continue
        nodes, slots = _prepare(item)
        shipped_slots = json.dumps(slots, ensure_ascii=False)
        if stored_sha == sha and str(row["slots"] or "") == shipped_slots:
            summary["skipped"].append(key)  # 正文与槽位约定都没变
            continue
        conn.execute(
            "UPDATE clone_templates SET workflow=?, slots=?, default_prompt=?, bundled_sha=?,"
            " updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (json.dumps(nodes, ensure_ascii=False), shipped_slots,
             default_prompt_for(nodes, slots), sha, int(row["id"])),
        )
        summary["updated"].append(key)

    if summary["inserted"] or summary["updated"] or summary["adopted"] or summary["renamed"]:
        logger.info(
            "内置再次创作工作流：新增 %s，刷新 %s，认领同名 %s（改名 %s）",
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
