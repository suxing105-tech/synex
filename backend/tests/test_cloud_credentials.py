"""云端凭据这一层：key 怎么存、谁能读出来、账号表怎么说话。

这里钉的是保密口径，不是功能：任何接口都不许把明文 key 回出去，也不许把 key
塞进 URL（那是最容易被日志和错误信息带出去的一条路）。
凭据的值本身不进断言——断言「有没有」和「回没回出来」就够了，测试里也不该出现真 key。
"""
from __future__ import annotations

import json
import sys

import pytest
from fastapi import HTTPException

from app import credentials
from app.cloud import accounts, spec as cloud_spec


SECRET = "sk-testsentinel-4f2a91"
WF_SECRET = "wf-testsentinel-9d1c07"


@pytest.fixture(autouse=True)
def _fresh_db(init_db):
    """每个用例一个干净的库：账号表是全局表，不留干净就会串味。"""
    return init_db


# ---------- credentials ----------


def test_key_persistence_says_whether_a_restart_needs_a_refill():
    want = "encrypted" if sys.platform == "win32" else "session"
    assert credentials.key_persistence() == want


def test_protect_unprotect_roundtrip_where_supported():
    if sys.platform != "win32":
        pytest.skip("DPAPI 只在 Windows 上；其它平台走 session，见下一条")
    blob = credentials.protect(SECRET)
    assert blob and SECRET.encode() not in blob      # 入库的必须是密文
    assert credentials.unprotect(blob) == SECRET


def test_unprotect_on_other_platform_says_refill():
    if sys.platform == "win32":
        pytest.skip("Windows 上能解，测的就是别的平台这句实话")
    with pytest.raises(HTTPException):
        credentials.unprotect(b"")


def test_session_store_is_scoped_and_erasable():
    scope = ("db", ("gen_account", 999))
    credentials.session_put(scope, "abc")
    assert credentials.session_get(scope) == "abc"
    credentials.session_pop(scope)
    assert credentials.session_get(scope) == ""


# ---------- accounts ----------


def test_two_keys_on_one_account_never_touch_each_other():
    """RunningHub 一行账号两把 Key：改一把不许动另一把。

    官方把工作流（消费级-会员·扣 RH币）与模型 API（企业级-共享·扣钱包余额）分成两类，
    混成一次写就会长出最难查的那种断线——用户只是补了把工作流 Key，出图突然说没密钥。
    """
    accounts.save_account({"api_key": SECRET, "workflow_api_key": WF_SECRET})
    rows = accounts.list_accounts()
    assert len(rows) == 1 and rows[0]["has_api_key"] and rows[0]["has_workflow_key"]
    assert accounts.shared_key() == SECRET
    assert accounts.shared_workflow_key() == WF_SECRET

    accounts.put_shared_workflow_key("")          # 只清工作流那把
    assert accounts.shared_workflow_key() == ""
    assert accounts.shared_key() == SECRET        # 模型那把一根毛都没动
    row = accounts.list_accounts()[0]
    assert row["has_api_key"] is True and row["has_workflow_key"] is False


def test_the_two_keys_get_their_own_session_scopes():
    """非 Windows 上 Key 只活在内存里：两把必须占两个作用域，否则后填的顶掉前一把。"""
    if sys.platform == "win32":
        pytest.skip("Windows 走 DPAPI 落盘，作用域只在别的平台上是唯一存放点")
    accounts.put_shared_key(SECRET)
    accounts.put_shared_workflow_key(WF_SECRET)
    assert accounts.shared_key() == SECRET
    assert accounts.shared_workflow_key() == WF_SECRET


def test_workflow_key_written_first_still_lands_on_one_row():
    """一家服务商只有一行：先写哪把 Key 都得落进同一行，别顺手多建一家。"""
    created = accounts.put_shared_workflow_key(WF_SECRET)
    accounts.put_shared_key(SECRET)
    rows = accounts.list_accounts()
    assert len(rows) == 1 and rows[0]["id"] == created["id"]
    assert accounts.shared_key() == SECRET and accounts.shared_workflow_key() == WF_SECRET


def test_old_db_without_the_workflow_column_upgrades_in_place():
    """老库只有 credential 那一列，不补列的话第一次读工作流 Key 就当场炸。"""
    legacy = ("CREATE TABLE gen_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT,"
              " provider TEXT NOT NULL, name TEXT NOT NULL,"
              " base_url TEXT NOT NULL DEFAULT 'https://www.runninghub.cn',"
              " proxy_mode TEXT NOT NULL DEFAULT 'system', enabled INTEGER NOT NULL DEFAULT 1,"
              " credential BLOB,"
              " created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),"
              " updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
    # initialize() 里的 executescript 会自己收尾事务，所以这段直接拿主连接，别套 transaction()
    conn = accounts._conn()
    conn.execute("DROP TABLE gen_accounts")
    conn.execute(legacy)
    accounts.initialize(conn)
    assert "credential_workflow" in {str(r[1]) for r in conn.execute("PRAGMA table_info(gen_accounts)")}
    row = accounts.save_account({"api_key": SECRET, "workflow_api_key": WF_SECRET})
    assert row["has_api_key"] and row["has_workflow_key"]
    assert accounts.shared_workflow_key() == WF_SECRET



def test_list_accounts_marks_the_row_the_engine_actually_uses():
    """清单里必须自己说清哪一行是真在用的那把 Key。

    库里可以多账号，界面只认一把。不标出来，界面只能按下标猜第一条——
    排在前面的空账号会把「卡片显示的那把」和「出图用的那把」分成两行。
    """
    accounts.save_account({"name": "空的"})                        # 排在最前，没 Key
    used = accounts.save_account({"name": "真用的", "api_key": SECRET})
    accounts.save_account({"name": "第二把", "api_key": SECRET})    # 后面再有一把也不许抢
    rows = accounts.list_accounts()
    assert [r["name"] for r in rows if r["is_shared"]] == ["真用的"]
    assert [r["id"] for r in rows if r["is_shared"]] == [used["id"]]
    assert accounts.shared_row()["id"] == used["id"]


def test_public_never_carries_the_key():
    row = accounts.save_account({"name": "我的 RunningHub", "api_key": SECRET})
    assert row["has_api_key"] is True
    assert row["key_persistence"] == credentials.key_persistence()
    dumped = json.dumps(row, ensure_ascii=False)
    assert SECRET not in dumped                      # 接口层没有任何一条路能把 key 读出来
    assert "credential" not in dumped                # 连密文都不回
    assert row["provider_label"] == cloud_spec.PROVIDER_LABEL


def test_omitting_api_key_keeps_it_and_empty_string_clears_it():
    row = accounts.save_account({"name": "A", "api_key": SECRET})
    kept = accounts.save_account({"name": "改了个名字"}, int(row["id"]))
    assert kept["has_api_key"] is True and kept["name"] == "改了个名字"
    cleared = accounts.save_account({"api_key": ""}, int(row["id"]))
    assert cleared["has_api_key"] is False
    assert accounts.key_for(accounts.get_row(int(row["id"])), quiet=True) == ""


def test_key_for_returns_plaintext_only_in_memory():
    row = accounts.save_account({"name": "A", "api_key": SECRET})
    stored = accounts.get_row(int(row["id"]))
    assert accounts.key_for(stored) == SECRET
    assert accounts.key_for(stored, quiet=True) == SECRET
    empty = accounts.save_account({"name": "B"})
    with pytest.raises(ValueError):
        accounts.key_for(accounts.get_row(int(empty["id"])))
    assert accounts.key_for(accounts.get_row(int(empty["id"])), quiet=True) == ""


def test_usable_account_needs_enabled_and_a_key():
    assert accounts.usable_account() is None
    no_key = accounts.save_account({"name": "没填 key"})
    assert accounts.usable_account() is None          # 没 key 不算可用
    disabled = accounts.save_account({"name": "关掉的", "api_key": SECRET, "enabled": False})
    assert accounts.usable_account() is None
    accounts.save_account({"enabled": True}, int(disabled["id"]))
    assert accounts.usable_account()["id"] == int(disabled["id"])
    accounts.save_account({"enabled": False}, int(disabled["id"]))
    assert accounts.usable_account() is None
    accounts.save_account({"api_key": SECRET}, int(no_key["id"]))
    assert accounts.usable_account()["id"] == int(no_key["id"])


def test_list_accounts_orders_by_id_and_reports_flags_only():
    accounts.save_account({"name": "第一家", "api_key": SECRET})
    accounts.save_account({"name": "第二家"})
    items = accounts.list_accounts()
    assert [i["name"] for i in items] == ["第一家", "第二家"]
    assert [i["has_api_key"] for i in items] == [True, False]
    assert SECRET not in json.dumps(items, ensure_ascii=False)


def test_base_url_must_not_carry_a_key_or_query():
    """把 key 写进 URL 是最容易被日志与错误信息带出去的写法，直接拒。"""
    with pytest.raises(HTTPException):
        accounts.save_account({"name": "坏", "base_url": "https://x.test/?apikey=" + SECRET})
    with pytest.raises(HTTPException):
        accounts.save_account({"name": "坏", "base_url": "http://evil.test"})   # http 只许本机


def test_base_url_defaults_to_the_provider_and_trims_slash():
    row = accounts.save_account({"name": "默认地址"})
    assert row["base_url"] == cloud_spec.BASE_URL
    custom = accounts.save_account({"base_url": "https://www.runninghub.cn/"}, int(row["id"]))
    assert custom["base_url"] == cloud_spec.BASE_URL


def test_only_runninghub_for_now():
    with pytest.raises(ValueError):
        accounts.save_account({"name": "别家", "provider": "other"})


def test_proxy_mode_is_one_of_two_words():
    row = accounts.save_account({"name": "直连", "proxy_mode": "direct"})
    assert row["proxy_mode"] == "direct" and row["proxy_label"] == "直连（不走代理）"
    with pytest.raises(ValueError):
        accounts.save_account({"proxy_mode": "auto"}, int(row["id"]))


def test_name_is_capped_where_the_ui_breaks():
    with pytest.raises(ValueError):
        accounts.save_account({"name": "长" * 41})


def test_delete_removes_the_row_and_the_session_key():
    """删账号要连内存里那份一起删：留着它，删掉的账号还能被 usable_account 挑中花钱。"""
    row = accounts.save_account({"name": "删我", "api_key": SECRET})
    account_id = int(row["id"])
    accounts.delete_account(account_id)
    assert accounts.list_accounts() == []
    with pytest.raises(KeyError):
        accounts.get_row(account_id)
    live = [k for k in credentials.SESSION_KEYS if str(k[1]) == str(("gen_account", account_id))]
    assert live == []

