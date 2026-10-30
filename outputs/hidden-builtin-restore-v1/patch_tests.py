# -*- coding: utf-8 -*-
"""恢复内置工作流：后端 6 条 + 前端 3 条测试。"""
import io

ROOT = "C:/Users/Administrator/Documents/ChatGPT/苏醒图库/"
BE = ROOT + "backend/tests/test_clone_bundled.py"
FE = ROOT + "frontend/src/__tests__/clone-settings.test.ts"

BE_TESTS = '''

# ---------- 已隐藏的内置工作流：看得见，也能反悔 ----------

def test_a_deleted_builtin_shows_up_as_hidden(seeded):
    """删掉的内置工作流必须出现在隐藏列表里。以前它只躺在 meta 里，谁都不知道。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    with TestClient(app) as client:
        items = client.get("/api/clone/templates/hidden").json()["items"]
    assert [i["key"] for i in items] == [AUDIO_KEY]
    assert items[0]["name"] == "闪寻参考音色" and items[0]["media_kind"] == "audio"


def test_the_hidden_list_is_empty_when_nothing_was_deleted(seeded):
    with TestClient(app) as client:
        assert client.get("/api/clone/templates/hidden").json()["items"] == []


def test_restore_brings_the_builtin_back_through_the_api(seeded):
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 200, res.text
        assert res.json()["name"] == "闪寻参考音色"
        items = client.get("/api/clone/templates").json()["items"]
        assert client.get("/api/clone/templates/hidden").json()["items"] == []
    assert {i["bundled_key"] for i in items} == set(ALL_KEYS)
    assert clone_bundled.dismissed(seeded.main()) == set(), "恢复要把名字从名单里摘干净"


def test_a_restored_mode_does_not_steal_the_current_one(seeded):
    """恢复回来的那条不许抢「当前」：同族已经有正在用的了，不然用户的默认被换掉。"""
    rows = {r["bundled_key"]: r for r in clone_templates.list_templates()}
    clone_templates.delete_template(rows[AUDIO_KEY]["id"])
    before = [r for r in clone_templates.list_templates()
              if r["media_kind"] == "audio" and r["is_active"]][0]["bundled_key"]
    clone_bundled.restore(AUDIO_KEY)
    audio = [r for r in clone_templates.list_templates() if r["media_kind"] == "audio"]
    assert len(audio) == 3
    assert [r["bundled_key"] for r in audio if r["is_active"]] == [before]


def test_restoring_something_never_hidden_is_404(seeded):
    with TestClient(app) as client:
        assert client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore").status_code == 404


def test_restore_is_409_when_the_name_is_taken(seeded):
    """模板名有唯一索引：名字被别条占着时装不进来，必须回 409 并说清下一步做什么。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    clone_templates.create_template("闪寻参考音色", _fake_entry(label="闪寻参考音色")["workflow"])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 409, res.text
        assert "改名" in res.json()["detail"]
    assert [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY] == []


def test_restore_clears_a_key_the_package_no_longer_ships(seeded, monkeypatch):
    """新版本不再随包这条：409 说清楚，同时把死名字从名单里清掉，别让它永远占着。"""
    row = [r for r in clone_templates.list_templates() if r["bundled_key"] == AUDIO_KEY][0]
    clone_templates.delete_template(row["id"])
    monkeypatch.setattr(clone_bundled, "entries", lambda *a, **k: [])
    with TestClient(app) as client:
        res = client.post("/api/clone/templates/hidden/" + AUDIO_KEY + "/restore")
        assert res.status_code == 409, res.text
    assert clone_bundled.dismissed(seeded.main()) == set()
'''

FE_TESTS = '''

// ---------- 已隐藏的内置工作流：看得见，也能反悔 ----------

const HIDDEN_VOICE = { key: 'qwen3-tts-voice-clone', name: '闪寻参考音色', media_kind: 'audio' };

it('已隐藏的内置工作流列出来，点恢复只 POST 那一条的 key', async () => {
  let hiddenItems: unknown[] = [HIDDEN_VOICE];
  let restoredPath: string | null = null;
  http.mockImplementation(async (path: string, init?: RequestInit) => {
    if (String(path).endsWith('/restore')) {
      restoredPath = path;
      hiddenItems = [];
      return { ok: true, id: 9, name: '闪寻参考音色' };
    }
    if (path === '/api/clone/templates/hidden') return { items: hiddenItems };
    if (path === '/api/clone/templates') {
      return { items: hiddenItems.length ? [TPL] : [TPL, { ...TPL, id: 9, name: '闪寻参考音色' }] };
    }
    throw new Error(`未预演的接口：${path}`);
  });
  const screen = render(CloneTemplates, {});
  expect(await screen.findByText(/已隐藏的内置工作流 1 条/)).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '恢复' }));
  await tick();
  await tick();
  expect(restoredPath).toBe('/api/clone/templates/hidden/qwen3-tts-voice-clone/restore');
  expect(screen.queryByRole('button', { name: '恢复' })).toBeNull();
  expect(await screen.findByText('闪寻参考音色')).toBeTruthy();
});

it('老后端没有隐藏接口时不炸，也不显示这一栏', async () => {
  http.mockImplementation(async (path: string) => {
    if (path === '/api/clone/templates') return { items: [TPL] };
    if (String(path).includes('/hidden')) throw new Error('404 Not Found');
    throw new Error(`未预演的接口：${path}`);
  });
  const screen = render(CloneTemplates, {});
  expect(await screen.findByText('旧的同款')).toBeTruthy();
  expect(screen.queryByText(/已隐藏的内置工作流/)).toBeNull();
});

it('隐藏接口答话里没有 key 就不当隐藏项渲染', async () => {
  // /api/clone/templates/hidden 是 /api/clone/templates 的前缀扩展，
  // 按前缀路由的预演很容易把模板答话喂给它。没有 key 就不是隐藏项。
  http.mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/clone/templates')) return { items: [TPL] };
    throw new Error(`未预演的接口：${path}`);
  });
  const screen = render(CloneTemplates, {});
  expect(await screen.findByText('旧的同款')).toBeTruthy();
  expect(screen.queryByText(/已隐藏的内置工作流/)).toBeNull();
});
'''


def append(path, block):
    t = io.open(path, encoding="utf-8", newline="").read()
    nl = "\r\n" if "\r\n" in t[:4000] else "\n"
    if not t.endswith(nl):
        t += nl
    t += block.replace("\n", nl)
    io.open(path, "w", encoding="utf-8", newline="").write(t)
    print("appended tests ->", path.rsplit("/", 1)[-1])


append(BE, BE_TESTS)
append(FE, FE_TESTS)