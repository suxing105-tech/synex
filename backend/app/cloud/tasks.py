"""gen_tasks：云端任务的账本。

为什么必须有这张表：本机 ComfyUI 跑十分钟，关掉窗口什么也不丢——图还在 output 目录里。
云端不一样，一条片子跑十分钟，产物挂在会过期的签名链接上。没有这张表就是
「钱花了、链接过期了、没人认领」，这是最容易白花钱的一处。

有了它才谈得上三件事：重启后还能说「有件事在跑」、链接过期后能重新取回、
以及「这一条到底花了多少」（用 remainCoins 的前后差值，不是自己乘出来的单价）。

params 存的是这次请求的快照（提示词、参考、参数、mode），够重发一次同样的。
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from ..db import get_pool, transaction

SCHEMA = """
CREATE TABLE IF NOT EXISTS gen_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    spec_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    capability TEXT NOT NULL DEFAULT 'image',
    state TEXT NOT NULL DEFAULT 'running',
    remote_task_id TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    coins_before REAL,
    coins_after REAL,
    cost_coins REAL,
    estimated_coins REAL,
    image_ids TEXT NOT NULL DEFAULT '[]',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gen_tasks_state ON gen_tasks(state, id DESC);
"""

NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
OPEN_STATES = ("uploading", "running", "lost")
FINAL_STATES = ("done", "failed", "cancelled")
STATE_LABELS = {"uploading": "上传参考素材", "running": "云端生成中", "lost": "断了，可取回",
                "done": "已完成", "failed": "失败", "cancelled": "已停止等待"}


def initialize(conn) -> None:
    conn.executescript(SCHEMA)


def _conn():
    return get_pool().main()


def public(row: dict) -> dict:
    data = dict(row)
    for key in ("params", "image_ids"):
        raw = data.get(key)
        try:
            data[key] = json.loads(raw) if isinstance(raw, str) else (raw or [])
        except ValueError:
            data[key] = {} if key == "params" else []
    data["state_label"] = STATE_LABELS.get(str(data.get("state")), str(data.get("state") or ""))
    return data


def start(*, job_id: str, spec_key: str, capability: str, model: str, params: dict,
          estimated_coins: float | None = None,
          provider: str = "runninghub") -> int:
    cur = _conn().execute(
        "INSERT INTO gen_tasks(job_id,provider,spec_key,model,capability,state,params,"
        " estimated_coins) VALUES(?,?,?,?,?,?,?,?)",
        (job_id, provider, spec_key, model, capability, "uploading",
         json.dumps(params, ensure_ascii=False), estimated_coins))
    return int(cur.lastrowid)


def update(task_id: int, **changes: Any) -> None:
    if not task_id:
        return
    allowed = {"state", "remote_task_id", "coins_before", "coins_after", "cost_coins",
               "estimated_coins", "error", "image_ids", "params"}
    fields = {k: v for k, v in changes.items() if k in allowed}
    if not fields:
        return
    if "image_ids" in fields and isinstance(fields["image_ids"], (list, tuple)):
        fields["image_ids"] = json.dumps(list(fields["image_ids"]), ensure_ascii=False)
    if "params" in fields and isinstance(fields["params"], dict):
        fields["params"] = json.dumps(fields["params"], ensure_ascii=False)
    sets = ", ".join(f"{k}=?" for k in fields)
    args = list(fields.values()) + [task_id]
    with transaction() as conn:
        conn.execute(f"UPDATE gen_tasks SET {sets}, updated_at={NOW_SQL} WHERE id=?", args)


def finish(task_id: int, state: str, **changes: Any) -> None:
    changes["state"] = state
    if state in FINAL_STATES:
        changes["finished_at"] = None  # 占位，下面用 SQL 表达式写时间
    update(task_id, **{k: v for k, v in changes.items() if k != "finished_at"})
    if state in FINAL_STATES:
        with transaction() as conn:
            conn.execute(f"UPDATE gen_tasks SET finished_at={NOW_SQL} WHERE id=?", [task_id])


def get(task_id: int) -> dict | None:
    row = _conn().execute("SELECT * FROM gen_tasks WHERE id=?", (task_id,)).fetchone()
    return public(dict(row)) if row else None


def open_tasks() -> list[dict]:
    marks = ",".join("?" * len(OPEN_STATES))
    rows = _conn().execute(
        f"SELECT * FROM gen_tasks WHERE state IN ({marks}) ORDER BY id", OPEN_STATES).fetchall()
    return [public(dict(r)) for r in rows]


def latest_open_for_job(job_id: str) -> dict | None:
    rows = [t for t in open_tasks() if str(t.get("job_id")) == str(job_id)]
    return rows[-1] if rows else None


def recent(limit: int = 30) -> list[dict]:
    rows = _conn().execute("SELECT * FROM gen_tasks ORDER BY id DESC LIMIT ?",
                           (max(1, int(limit)),)).fetchall()
    return [public(dict(r)) for r in rows]


def spend_today_coins() -> float:
    """今天已经花掉的 RH币。没有实测差值的任务算 0——宁可少报，不编数。"""
    row = _conn().execute(
        "SELECT COALESCE(SUM(cost_coins),0) AS total FROM gen_tasks"
        f" WHERE cost_coins IS NOT NULL AND date(created_at)=date({NOW_SQL})").fetchone()
    return float(row["total"] or 0) if row else 0.0


def spend_month(month: str) -> dict:
    rows = _conn().execute(
        "SELECT capability, COUNT(*) AS n, COALESCE(SUM(cost_coins),0) AS coins FROM gen_tasks"
        f" WHERE strftime('%Y-%m', created_at)=? GROUP BY capability", (month,)).fetchall()
    counts = {"image": 0, "video": 0, "audio": 0}
    total = 0.0
    for item in rows:
        counts[str(item["capability"])] = int(item["n"])
        total += float(item["coins"] or 0)
    return {"month": month, "counts": counts, "coins": round(total, 4)}


def reset_for_tests() -> None:
    conn = _conn()
    conn.execute("DELETE FROM gen_tasks")

