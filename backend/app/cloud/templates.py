"""把云端模型声明变成弹窗里的那几条模板行（engine='cloud'）。

为什么走「种子」而不是每次启动都刷：用户删掉「图片API」这条快捷方式，说明他不想看见它。
每次启动又长回来，等于告诉用户这一行不归他管。所以只在第一次装库时种一次，
删了想再要回来走设置页那句「恢复云端 API 快捷方式」（显式 sync）。

槽位是直接写库的，没走 clone_templates.normalize_slots：那个函数要先核对 ComfyUI 节点，
而云端模板一个节点都没有。槽位由 cloud/spec.py 手写声明生成，形状与本机一模一样
（prompt / 三族参考位 / select / number），所以弹窗那套控件原样能用。

建库路径上的两条纪律（都踩过）：main() 会在 initialize 里重进不可重入的锁，所以
凡是被 db.initialize 调到的函数都只能用调用方给的连接；workflow 列是 NOT NULL。
"""
from __future__ import annotations

import json
import os

from ..db import get_pool
from . import spec as cloud_spec

SEED_FLAG = "cloud_templates_seeded"
# 与内置工作流同一把开关的写法：绝大多数用例的前提是「模板表一开始是空的」，
# 测云端自己的用例自己把它打开。生产不设这个环境变量，照常种一次。
SEED_ENV = "SUXING_SEED_CLOUD_TEMPLATES"
NAME_SUFFIX = "API"
NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"


def _conn():
    return get_pool().main()


def row_for(spec, conn=None) -> dict | None:
    """这条声明在库里的行：先认 model，再认名字（老库里可能只有名字对得上）。"""
    conn = conn or _conn()
    row = conn.execute("SELECT * FROM clone_templates WHERE engine='cloud' AND model=?",
                       (spec.key,)).fetchone()
    if row:
        return dict(row)
    named = conn.execute("SELECT * FROM clone_templates WHERE name=?",
                         (cloud_spec.template_name(spec),)).fetchone()
    if named and str(named["engine"] or "") == "cloud":
        return dict(named)
    return None


def _pick_name(spec, conn) -> str:
    """一族只有一条云端模型时就叫「图片API」；名字被人占了才带上模型名。"""
    base = cloud_spec.template_name(spec)
    if not conn.execute("SELECT 1 FROM clone_templates WHERE name=?", (base,)).fetchone():
        return base
    return f"{base} · {spec.model_label}"[:40]


def sync(conn=None) -> dict:
    """建或更新那三条云端模板行。幂等：跑几次结果都一样，声明改了会跟着刷新。

    永远不抢「当前」，一个族都没有本机配方时也不抢：把一条要花钱的通道设成默认，
    等于替用户做了一个他没做过的决定。想让它当默认，在清单里点一次就行。
    （用户把同族本机那条删掉之后，_ensure_active_kind 仍会照既有规矩顶上，那是他的选择。）
    """
    # 建库路径上要拿调用方给的连接：ConnectionPool.main() 会重进 initialize()，
    # 而那把锁不可重入——在 initialize 里调它就是当场死锁（真踩过）。
    conn = conn or _conn()
    created: list[str] = []
    updated: list[str] = []
    for spec in cloud_spec.all_specs():
        slots = json.dumps(spec.slots(), ensure_ascii=False)
        params = json.dumps(spec.default_controls(), ensure_ascii=False)
        existing = row_for(spec, conn)
        if existing:
            conn.execute(
                f"UPDATE clone_templates SET name=?, slots=?, params=?, provider=?, model=?,"
                f" engine='cloud', workflow='', media_kind=?, updated_at={NOW_SQL} WHERE id=?",
                (str(existing["name"]), slots, params, cloud_spec.PROVIDER, spec.key,
                 spec.capability, int(existing["id"])),
            )
            updated.append(str(existing["name"]))
            continue
        name = _pick_name(spec, conn)
        conn.execute(
            # workflow 空串而不是 NULL：那一列是 NOT NULL，且 parse_workflow("") 本来就会
            # 被判成「没有节点」，云端模板一个节点都没有，正好。
            "INSERT INTO clone_templates(name, workflow, slots, default_prompt, is_active,"
            " media_kind, engine, provider, model, params)"
            " VALUES(?, '', ?, '', ?, ?, 'cloud', ?, ?, ?)",
            (name, slots, 0, spec.capability,
             cloud_spec.PROVIDER, spec.key, params),
        )
        created.append(name)
    return {"created": created, "updated": updated}


def _meta_get(conn, key: str, default: int = 0) -> int:
    """自带一份 meta 读写：db.get_int_meta 走 pool.main()，建库路径上不能碰。"""
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    try:
        return int(row["value"]) if row else default
    except (TypeError, ValueError):
        return default


def _meta_set(conn, key: str, value: object) -> None:
    conn.execute("INSERT INTO meta(key, value) VALUES(?, ?)"
                 " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, str(value)))


def seed_once(conn=None) -> dict:
    """第一次装库时种一次。之后由用户自己决定留不留（删了就别再长回来）。"""
    own = conn is None
    conn = conn or _conn()
    if os.environ.get(SEED_ENV, "1") == "0":
        return {"created": [], "updated": [], "skipped": True, "disabled": True}
    if _meta_get(conn, SEED_FLAG, 0):
        return {"created": [], "updated": [], "skipped": True}
    result = sync(conn)
    _meta_set(conn, SEED_FLAG, 1)
    result["skipped"] = False
    if not own:
        return result
    return result


def is_seeded() -> bool:
    from ..db import get_int_meta

    return bool(get_int_meta(SEED_FLAG, 0))


def remove_for(spec_key: str) -> int:
    """删掉某条声明对应的快捷方式（设置页用）。Key 与账号一个都不动。"""
    spec = cloud_spec.spec_by_key(spec_key)
    if spec is None:
        raise ValueError("这条云端 API 不认识，没东西可删。")
    row = row_for(spec)
    if row is None:
        return 0
    from ..clone_templates import delete_template

    return delete_template(int(row["id"]))

