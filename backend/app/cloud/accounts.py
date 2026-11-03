"""云端账号：provider + base_url + key，key 走 DPAPI，接口只回 has_api_key。

与视觉模型那套的差别只有一处：视觉模型一条配置对应一个 base_url+model，
云端账号对应一家服务商（base_url 固定，模型由 spec 决定）。存法完全一样。

保密口径（AGENTS.md 的敏感边界落在这里）：
- 明文 key 只在 key_for() 返回的那一瞬间存在于内存，交给请求头用；
- list/public 只有 has_api_key 布尔，没有任何接口能把 key 读出来；
- base_url 过 reverse_prompts.normalize_url：不许带账号与 query，http 只许本机——
  防的是把 key 发给一个本机假服务。
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from .. import credentials, db
from ..db import get_pool, transaction
from . import spec as cloud_spec

SCHEMA = """
CREATE TABLE IF NOT EXISTS gen_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT 'https://www.runninghub.cn',
    proxy_mode TEXT NOT NULL DEFAULT 'system',
    enabled INTEGER NOT NULL DEFAULT 1,
    credential BLOB,
    credential_workflow BLOB,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""

NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
PROXY_MODES = ("system", "direct")
PROXY_LABELS = {"system": "跟随系统代理", "direct": "直连（不走代理）"}

# RunningHub 有两把 Key，各花各的钱，别混：
# - model    = 模型 API 密钥（企业级-共享）→ 三条收费模型 API + 反推 LLM，扣钱包余额；
# - workflow = 工作流 API 密钥（消费级-会员）→ 跑云端 ComfyUI 工作流，扣 RH币。
# 官方要求这两类各用各的 Key，所以一行账号存两列密文，不是一行一把。
KEY_KINDS = {
    "model": ("credential", "gen_account"),
    "workflow": ("credential_workflow", "gen_account_wf"),
}
_MISSING = {
    "model": "这条云端账号还没有填模型 API Key（企业级-共享），去设置 → 模型API配置里填。",
    "workflow": "这条云端账号还没有填工作流 API Key（消费级-会员），去设置 → 模型API配置里填。",
}
# 老库补列：credential_workflow 是后加的，不补列的库会在第一次读 workflow 时炸
_ADDED_COLUMNS = (("credential_workflow", "BLOB"),)


def initialize(conn) -> None:
    conn.executescript(SCHEMA)
    have = {str(r[1]) for r in conn.execute("PRAGMA table_info(gen_accounts)")}
    for column, ddl in _ADDED_COLUMNS:
        if column not in have:
            conn.execute(f"ALTER TABLE gen_accounts ADD COLUMN {column} {ddl}")


def _conn():
    return get_pool().main()


def _scope(account_id: Any, kind: str = "model"):
    # 两把 Key 各占一个作用域：共用一个的话，非 Windows 上后填的那把会悄悄顶掉前一把
    return (str(get_pool().path), (KEY_KINDS[kind][1], int(account_id)))


def public(row: dict) -> dict:
    account_id = int(row["id"])
    provider = str(row["provider"])
    return {
        "id": account_id,
        "provider": provider,
        "provider_label": cloud_spec.PROVIDER_LABEL if provider == cloud_spec.PROVIDER else provider,
        "name": str(row["name"]),
        "base_url": str(row["base_url"]),
        "proxy_mode": str(row["proxy_mode"] or "system"),
        "proxy_label": PROXY_LABELS.get(str(row["proxy_mode"] or "system"), "跟随系统代理"),
        "enabled": bool(row["enabled"]),
        # 只有布尔：没有任何接口能把 key 读出来，也就不存在「复制给别人」。
        "has_api_key": bool(row.get("credential")) or bool(credentials.session_get(_scope(account_id))),
        # 工作流那把是可选的：没有它，三条收费模型 API 照跑
        "has_workflow_key": bool(row.get("credential_workflow"))
        or bool(credentials.session_get(_scope(account_id, "workflow"))),
        "key_persistence": credentials.key_persistence(),
    }


def list_accounts() -> list[dict]:
    """账号清单顺带标出「引擎真正会用的那一行」。

    多账号仍在库里（后端一直支持），界面只认一把。以前界面按下标取第一条、
    引擎按「开着且填了 Key 的第一条」——库里排在前面的空账号会把两边分开，
    表现是「卡片说已配置、测的是 A、出图用的是 B」。标出来，两边就没法各猜。
    """
    rows = _conn().execute("SELECT * FROM gen_accounts ORDER BY id").fetchall()
    shared_id = (shared_row() or {}).get("id")
    return [{**public(dict(r)),
             "is_shared": shared_id is not None and int(r["id"]) == int(shared_id)} for r in rows]


def get_row(account_id: int) -> dict:
    row = _conn().execute("SELECT * FROM gen_accounts WHERE id=?", (account_id,)).fetchone()
    if row is None:
        raise KeyError(f"云端账号 {account_id} 不存在，可能已经被删掉了。")
    return dict(row)


def key_for(row: dict, *, quiet: bool = False, kind: str = "model") -> str:
    blob = row.get(KEY_KINDS[kind][0])
    if blob:
        try:
            return credentials.unprotect(bytes(blob))
        except HTTPException:
            if quiet:
                return ""
            raise
    value = credentials.session_get(_scope(int(row["id"]), kind))
    if value:
        return value
    if quiet:
        return ""
    raise ValueError(_MISSING[kind])


def shared_row() -> dict | None:
    """「一把 Key 走天下」里那把 Key 落在哪一行。

    先给 usable_account()：反推侧和一键同款必须读同一行，否则会出现「一键同款能跑、
    反推说没 Key」这种查起来最费劲的分叉。一家都没配 Key 时退到第一行 RunningHub 账号，
    让第一次填 Key 有唯一去处。
    """
    usable = usable_account()
    if usable:
        return usable
    row = _conn().execute(
        "SELECT * FROM gen_accounts WHERE provider=? ORDER BY id LIMIT 1", (cloud_spec.PROVIDER,)
    ).fetchone()
    return dict(row) if row else None


def shared_key(quiet: bool = True) -> str:
    """反推侧发请求时拿的那把 Key；没有就回空串，让界面能说清「差这一步」。"""
    row = shared_row()
    return key_for(row, quiet=quiet) if row else ""


def put_shared_key(text: str) -> dict:
    """把 Key 写进唯一那个家：有账号就改那一行，一家都没有就顺手建一家。"""
    row = shared_row()
    if row is None:
        return save_account({"api_key": text, "name": cloud_spec.PROVIDER_LABEL})
    return save_account({"api_key": text}, int(row["id"]))


def shared_workflow_key(quiet: bool = True) -> str:
    """云端工作流那把 Key（消费级-会员，扣 RH币）。还没配就回空串，让界面说清差这一步。"""
    row = shared_row()
    return key_for(row, quiet=quiet, kind="workflow") if row else ""


def put_shared_workflow_key(text: str) -> dict:
    """工作流 Key 也落在同一行账号上：一家服务商一行，两把 Key 两列。"""
    row = shared_row()
    patch_ = {"workflow_api_key": text}
    if row is None:
        return save_account({**patch_, "name": cloud_spec.PROVIDER_LABEL})
    return save_account(patch_, int(row["id"]))


def usable_account() -> dict | None:
    """能用的那家账号：开了、填了 key、服务商是我们支持的那家。

    回 None 而不是抛错，是为了让设置页能说「还差哪一步」，弹窗也能照这个说。
    """
    for row in _conn().execute("SELECT * FROM gen_accounts ORDER BY id").fetchall():
        item = dict(row)
        if not item["enabled"] or str(item["provider"]) != cloud_spec.PROVIDER:
            continue
        if key_for(item, quiet=True):
            return item
    return None


def _normalize_base_url(value: str) -> str:
    from ..reverse_prompts import normalize_url

    url = str(value or "").strip() or cloud_spec.BASE_URL
    return normalize_url(url).rstrip("/")


def save_account(patch: dict, account_id: int | None = None) -> dict:
    """建号或改号。api_key 没出现 = 不动；出现且为空串 = 清掉。"""
    row = get_row(account_id) if account_id is not None else None
    provider = str(patch.get("provider") or (row or {}).get("provider") or cloud_spec.PROVIDER)
    if provider != cloud_spec.PROVIDER:
        raise ValueError("第一版只接 RunningHub 这一家服务商。")
    name = str(patch.get("name") or (row or {}).get("name") or "").strip() or cloud_spec.PROVIDER_LABEL
    if len(name) > 40:
        raise ValueError("名字最长 40 个字。")
    base_url = _normalize_base_url(patch["base_url"] if "base_url" in patch
                                   else (row or {}).get("base_url") or cloud_spec.BASE_URL)
    proxy_mode = str(patch.get("proxy_mode") or (row or {}).get("proxy_mode") or "system")
    if proxy_mode not in PROXY_MODES:
        raise ValueError("代理方式只有跟随系统和直连两种。")
    enabled = bool((row or {}).get("enabled", 1)) if patch.get("enabled") is None else bool(patch["enabled"])

    # 两把 Key 各写各的：patch 里没出现 = 不动那一列；出现且是空串 = 只清那一把。
    # 混成一次写的话，「改工作流 Key」会把模型 Key 一起清掉——那是最难查的一种断线。
    written: dict[str, str] = {}
    credentials_by_kind = {}
    for kind, patch_key in (("model", "api_key"), ("workflow", "workflow_api_key")):
        column = KEY_KINDS[kind][0]
        incoming = patch.get(patch_key)
        credentials_by_kind[kind] = (row or {}).get(column)
        if incoming is not None:
            text = str(incoming).strip()
            credentials_by_kind[kind] = credentials.protect(text) if text else None
            written[kind] = text
    credential = credentials_by_kind["model"]
    credential_wf = credentials_by_kind["workflow"]
    with transaction() as conn:
        args = [provider, name, base_url, proxy_mode, 1 if enabled else 0, credential, credential_wf]
        if row:
            conn.execute(
                f"UPDATE gen_accounts SET provider=?, name=?, base_url=?, proxy_mode=?,"
                f" enabled=?, credential=?, credential_workflow=?, updated_at={NOW_SQL} WHERE id=?",
                args + [account_id])
        else:
            account_id = conn.execute(
                "INSERT INTO gen_accounts(provider,name,base_url,proxy_mode,enabled,credential,"
                "credential_workflow) VALUES(?,?,?,?,?,?,?)", args).lastrowid
    for kind, text in written.items():
        if text and credentials.key_persistence() != "encrypted":
            credentials.session_put(_scope(int(account_id), kind), text)
        else:
            credentials.session_pop(_scope(int(account_id), kind))
    return public(get_row(int(account_id)))


def delete_account(account_id: int) -> int:
    get_row(account_id)
    with transaction() as conn:
        conn.execute("DELETE FROM gen_accounts WHERE id=?", (account_id,))
    for kind in KEY_KINDS:
        credentials.session_pop(_scope(account_id, kind))
    return account_id

