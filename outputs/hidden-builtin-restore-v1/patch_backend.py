# -*- coding: utf-8 -*-
"""恢复内置工作流的门（后端 + lib/clone.ts）。

删内置工作流以前是单向门：拉黑名单不显示、也不给反悔，用户删错只能改库。
v0.2.31 那次「音频少一种模式」就是这个洞的真实代价。
"""
import io

ROOT = "C:/Users/Administrator/Documents/ChatGPT/苏醒图库/"
ARROW = chr(0x2192)

BUNDLED = ROOT + "backend/app/clone_bundled.py"
ROUTES = ROOT + "backend/app/routes/clone.py"
CLONETS = ROOT + "frontend/src/lib/clone.ts"

B1_OLD = '''def note_dismissal(conn, key: str) -> None:
    """用户删掉一条内置模板 @@ARROW@@ 记一笔，别下次启动又塞回去。"""
    if not key:
        return
    keys = dismissed(conn) | {str(key)}
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DISMISSED_META_KEY, json.dumps(sorted(keys), ensure_ascii=False)),
    )'''.replace("@@ARROW@@", ARROW)

B1_NEW = '''def _set_dismissed(conn, keys: set[str]) -> None:
    """拉黑名单整体覆写。记删除、恢复、拆分放行三处都写它，共用一份。"""
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (DISMISSED_META_KEY, json.dumps(sorted(str(k) for k in keys), ensure_ascii=False)),
    )


def note_dismissal(conn, key: str) -> None:
    """用户删掉一条内置模板 @@ARROW@@ 记一笔，别下次启动又塞回去。"""
    if not key:
        return
    _set_dismissed(conn, dismissed(conn) | {str(key)})


class RestoreBlocked(ValueError):
    """恢复被挡住的具体原因。路由层照它决定 409 说什么话。"""


def hidden_templates() -> list[dict]:
    """被删掉、因此不再自动装载的内置工作流（设置页列出来，附一颗恢复）。

    这条接口存在的理由：以前删内置工作流是单向门，名单既看不见也没有反悔，
    删错只能进库改。随包清单读不出来时返回空表 @@ARROW@@ 设置页顶多少一颗恢复按钮，
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
    return {"id": int(row["id"]), "name": str(catalog[clean]["label"])}'''.replace("@@ARROW@@", ARROW)

B2_OLD = '''    if forgiven:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (DISMISSED_META_KEY, json.dumps(sorted(gone - hit), ensure_ascii=False)),
        )
        logger.info('''
B2_NEW = '''    if forgiven:
        _set_dismissed(conn, gone - hit)
        logger.info('''

R1_OLD = "from .. import clone_jobs, clone_sources, clone_templates"
R1_NEW = "from .. import clone_bundled, clone_jobs, clone_sources, clone_templates"

R2_OLD = '''@router.post("/templates/inspect")'''
R2_NEW = '''@router.get("/templates/hidden")
def list_hidden_bundled_templates() -> dict:
    """被用户删掉的随包工作流。设置页列出来，附一颗恢复按钮。"""
    return {"items": clone_bundled.hidden_templates()}


@router.post("/templates/inspect")'''

R3_OLD = '''@router.post("/templates/{template_id}/redetect")'''
R3_NEW = '''@router.post("/templates/hidden/{key}/restore")
def restore_hidden_bundled_template(key: str) -> dict:
    """恢复一条被删掉的随包工作流。

    404 = 这条根本不在隐藏名单里；409 = 名字被别条占着（模板名有唯一索引），
    得先改名。两种都得说人话，不然用户只会以为按钮坏了。
    """
    try:
        restored = clone_bundled.restore(key)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except clone_bundled.RestoreBlocked as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, **restored}


@router.post("/templates/{template_id}/redetect")'''

T1_OLD = "export const cloneApi = {"
T1_NEW = '''/** 被删掉的随包工作流：设置页「已隐藏的内置工作流」那一栏用它。 */
export type CloneHiddenBuiltin = { key: string; name: string; media_kind: string };

export const cloneApi = {'''

T2_OLD = '''  remove(id: number): Promise<{ ok: boolean; deleted: number }> {
    return api.http<{ ok: boolean; deleted: number }>(`/api/clone/templates/${id}`, { method: "DELETE" });
  },'''
T2_NEW = T2_OLD + '''
  /** 已隐藏的随包工作流。只认带 key 的条目：老后端没这个接口、测试里按前缀路由
      也可能把 /api/clone/templates 的答话一起给它，没 key 就不是隐藏项。 */
  hiddenTemplates(): Promise<CloneHiddenBuiltin[]> {
    return api.http<{ items?: CloneHiddenBuiltin[] }>("/api/clone/templates/hidden")
      .then((res) => (Array.isArray(res?.items)
        ? res.items.filter((one) => typeof one?.key === "string") : []));
  },
  /** 恢复一条被删掉的随包工作流：名字被占时后端回 409，话由它说。 */
  restoreHidden(key: string): Promise<{ ok: boolean; id: number; name: string }> {
    return api.http<{ ok: boolean; id: number; name: string }>(
      `/api/clone/templates/hidden/${encodeURIComponent(key)}/restore`, { method: "POST" });
  },'''


def patch(path, pairs):
    t = io.open(path, encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in t[:4000] else "\n"
    for a, b in pairs:
        a2, b2 = a.replace("\n", nl), b.replace("\n", nl)
        if t.count(a2) != 1:
            raise SystemExit("anchor miss %s :: %s :: %d" % (path, a.splitlines()[0][:50], t.count(a2)))
        t = t.replace(a2, b2)
    io.open(path, "w", encoding="utf-8", newline="").write(t)
    print("patched", path.rsplit("/", 1)[-1])


patch(BUNDLED, [(B1_OLD, B1_NEW), (B2_OLD, B2_NEW)])
patch(ROUTES, [(R1_OLD, R1_NEW), (R2_OLD, R2_NEW), (R3_OLD, R3_NEW)])
patch(CLONETS, [(T1_OLD, T1_NEW), (T2_OLD, T2_NEW)])