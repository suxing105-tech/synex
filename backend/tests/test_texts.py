import codecs
from pathlib import Path

import pytest
from fastapi import HTTPException
from app import texts


def test_manual_reorder_preserves_hidden_items_and_survives_reindex(init_db, tmp_path):
    docs = [texts.create(str(tmp_path), f'{i}.md', '正文') for i in range(4)]
    initial = [d['id'] for d in texts.listing()['items']]
    visible = [initial[3], initial[0]]
    texts.reorder(visible)
    expected = [initial[3], initial[1], initial[2], initial[0]]
    assert [d['id'] for d in texts.listing(sort='manual')['items']] == expected
    texts.index(Path(docs[0]['path']))
    assert [d['id'] for d in texts.listing(sort='manual')['items']] == expected
    assert [d['id'] for d in texts.listing(sort='manual', offset=1, limit=2)['items']] == expected[1:3]
    with pytest.raises(ValueError):
        texts.reorder([initial[0], initial[0]])
    with pytest.raises(ValueError):
        texts.reorder([initial[0], 999999])
    assert [d['id'] for d in texts.listing(sort='manual')['items']] == expected


@pytest.fixture
def document(init_db, tmp_path):
    p = tmp_path / '剧本.md'
    p.write_bytes(codecs.BOM_UTF8 + '# 开场\r\n中文提示词\r\n'.encode())
    return p, texts.index(p)['id']


def test_roundtrip_bom_newline_and_conflict(document):
    p, ident = document
    d = texts.detail(ident)
    saved = texts.save(ident, d['body'] + '第二幕\n', d['version'])
    assert p.read_bytes() == codecs.BOM_UTF8 + '# 开场\r\n中文提示词\r\n第二幕\r\n'.encode()
    p.write_text('外部编辑', encoding='utf8')
    with pytest.raises(HTTPException) as e:
        texts.save(ident, '不应覆盖', saved['version'])
    assert e.value.status_code == 409
    assert p.read_text(encoding='utf8') == '外部编辑'


def test_chinese_search_literal_and_history(document):
    p, ident = document
    assert texts.listing(q='文提示')['items'][0]['id'] == ident
    d = texts.detail(ident)
    texts.save(ident, '新正文 100%_完成', d['version'])
    assert not texts.listing(q='文提示')['items']
    assert texts.listing(q='%_')['total'] == 1
    h = texts.history(ident)
    assert texts.historical(ident, h[0]['id'])['body'] == d['body']
    current = texts.detail(ident)
    texts.save(ident, d['body'], current['version'], force_history=True)
    assert len(texts.history(ident)) == 2


@pytest.mark.parametrize('ext', ['txt', 'md', 'markdown', 'srt', 'vtt'])
def test_create_formats_and_collision(init_db, tmp_path, ext):
    d = texts.create(str(tmp_path), f'新文档.{ext}', '中文')
    assert d['body'] == '中文'
    with pytest.raises(FileExistsError):
        texts.create(str(tmp_path), f'新文档.{ext}', '不能覆盖')


def test_encoding_selection(init_db, tmp_path):
    p = tmp_path / '字幕.srt'
    p.write_bytes('中文\r\n字幕'.encode('gb18030'))
    ident = texts.index(p)['id']
    d = texts.detail(ident)
    assert d['readonly'] and d['needs_encoding']
    with pytest.raises(ValueError):
        texts.save(ident, '更新', d['version'])
    d = texts.detail(ident, 'gb18030')
    assert not d['needs_encoding']
    texts.save(ident, d['body'] + '\n新增', d['version'])
    assert p.read_bytes().decode('gb18030') == '中文\r\n字幕\r\n新增'


def test_association_explicit_only_and_reconcile(init_db, tmp_path):
    folder = tmp_path / '创作'
    folder.mkdir()
    (folder / 'a.txt').write_text('初稿', encoding='utf8')
    (folder / 'password.txt').write_text('excluded', encoding='utf8')
    assert texts.preview([str(folder)])['total'] == 1
    assert texts.listing()['total'] == 0
    texts.associate([str(folder)])
    (folder / 'b.md').write_text('新稿', encoding='utf8')
    texts.reconcile()
    assert texts.listing()['total'] == 2
    (folder / 'a.txt').unlink()
    texts.reconcile()
    assert texts.listing()['total'] == 1


def test_associated_subdirectories_share_folder_tree(init_db, tmp_path):
    root = tmp_path / '创作项目'
    sub = root / '剧本'
    sub.mkdir(parents=True)
    (sub / '第一集.md').write_text('剧情', encoding='utf8')
    texts.associate([str(root)])
    parent = texts.conn().execute('SELECT * FROM folders WHERE name=?', ('创作项目',)).fetchone()
    child = texts.conn().execute('SELECT * FROM folders WHERE name=?', ('剧本',)).fetchone()
    assert child['parent_id'] == parent['id']
    assert texts.listing(folder_id=child['id'])['total'] == 1
    from app import repository
    repository.ensure_system_folder_chain(sub / 'image.png', root)
    child = texts.conn().execute('SELECT * FROM folders WHERE id=?', (child['id'],)).fetchone()
    assert child['parent_id'] == parent['id']


def test_remap_preserves_ids_and_relative_references(init_db, tmp_path):
    old = tmp_path / '旧'
    old.mkdir()
    p = old / '文.md'
    p.write_text('![参考](../image.png)', encoding='utf8')
    ident = texts.index(p)['id']
    nested = tmp_path / '目标'
    nested.mkdir()
    new = nested / '新'
    old.rename(new)
    texts.remap(old, new)
    d = texts.detail(ident)
    assert d['path'] == str(new / '文.md')
    assert '../../image.png' in d['body']


def test_trash_failure_never_unlinks(document, monkeypatch):
    p, ident = document
    def fail(_):
        raise OSError('回收站不可用')
    monkeypatch.setattr(texts, 'recycle_file', fail)
    with pytest.raises(OSError):
        texts.trash(ident, texts.detail(ident)['version'])
    assert p.exists()
    assert texts.listing()['total'] == 1


def test_readonly_and_atomic_failure(document, monkeypatch):
    p, ident = document
    d = texts.detail(ident)
    original = p.read_bytes()
    def fail(*_):
        raise PermissionError('文件被锁定')
    monkeypatch.setattr(texts.os, 'replace', fail)
    with pytest.raises(PermissionError):
        texts.save(ident, '新内容', d['version'])
    assert p.read_bytes() == original
    assert not list(p.parent.glob('.seekx-*.tmp'))


def test_asset_does_not_serve_arbitrary_files(document):
    _, ident = document
    with pytest.raises(HTTPException):
        texts.asset(ident, '../private.txt')
    with pytest.raises(HTTPException):
        texts.asset(ident, 'https://example.com/x.png')


def test_api_version_conflict_and_validation(document):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routes.texts import router
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    _, ident = document
    assert client.get(f'/api/texts/{ident}').status_code == 200
    response = client.put(f'/api/texts/{ident}', json={'body': 'x', 'version': 'stale'})
    assert response.status_code == 409
    assert client.get('/api/texts?limit=-1').status_code == 422


def test_references_inside_code_are_not_rewritten(init_db, tmp_path):
    p = tmp_path / '文.md'
    p.write_text('`![示例](old.png)`\n\n```\n![示例](old.png)\n```\n\n![图](old.png)', encoding='utf8')
    ident = texts.index(p)['id']
    texts.remap(tmp_path / 'old.png', tmp_path / 'new.png')
    body = texts.detail(ident)['body']
    assert body.count('old.png') == 2 and body.count('new.png') == 1


def test_unicode_encodings_and_mixed_newlines(init_db, tmp_path):
    p = tmp_path / '混合.txt'
    raw = codecs.BOM_UTF16_LE + '第一行\r\n第二行\n第三行'.encode('utf-16-le')
    p.write_bytes(raw)
    ident = texts.index(p)['id']
    d = texts.detail(ident)
    texts.save(ident, d['body'], d['version'])
    assert p.read_bytes() == raw


def test_conflict_resolution_always_keeps_disk_version(document):
    p, ident = document
    first = texts.detail(ident)
    texts.save(ident, '应用保存', first['version'])
    p.write_text('外部内容必须保留', encoding='utf8')
    disk = texts.detail(ident)
    texts.save(ident, '用户决定保留当前编辑', disk['version'], force_history=True)
    assert any(texts.historical(ident, h['id'])['body'] == '外部内容必须保留' for h in texts.history(ident))


def test_native_recycle_own_disposable_file(tmp_path):
    import os
    if os.name != 'nt':
        pytest.skip('Windows recycle-bin integration')
    p = tmp_path / 'seekx-disposable-recycle-test.txt'
    p.write_text('Only this test-created file is recycled.', encoding='utf8')
    texts.recycle_file(p)
    assert not p.exists()


def test_folder_move_updates_documents_and_external_references(init_db, tmp_path):
    from app import folder_storage
    folder = folder_storage.create_folder('旧项目', None)
    root = Path(folder['path'])
    note = root / '剧本.md'
    note.write_text('![图](image.png)', encoding='utf8')
    image = root / 'image.png'
    image.write_bytes(b'test fixture')
    outside = tmp_path / '索引.md'
    outside.write_text(f'![图]({texts.reference(outside, image)})', encoding='utf8')
    ident = texts.index(note)['id']
    other = texts.index(outside)['id']
    texts.conn().execute('INSERT INTO images(path,filename,size_bytes,mtime) VALUES(?,?,?,?)', (image.as_posix(), image.name, 12, 1))
    folder_storage.rename_folder(folder['id'], '新项目')
    d = texts.detail(ident)
    assert Path(d['path']).parent.name == '新项目'
    assert d['body'] == '![图](image.png)'
    assert '新项目' in texts.unquote(texts.detail(other)['body'])
    assert texts.asset(ident, 'image.png')[0].name == 'image.png'


def test_readonly_reference_failure_remains_visible(init_db, tmp_path):
    import stat
    note = tmp_path / 'readonly.md'
    note.write_text('![图](old.png)', encoding='utf8')
    ident = texts.index(note)['id']
    note.chmod(stat.S_IREAD)
    try:
        texts.remap(tmp_path / 'old.png', tmp_path / 'new.png')
        assert '引用维护失败' in texts.detail(ident)['error']
    finally:
        note.chmod(stat.S_IREAD | stat.S_IWRITE)


def test_history_expiry_and_coalescing(document, monkeypatch):
    _, ident = document
    d = texts.detail(ident)
    texts.save(ident, '第一次', d['version'])
    d = texts.detail(ident)
    texts.save(ident, '第二次', d['version'])
    assert len(texts.history(ident)) == 1
    future = texts.time.time() + 31 * 86400
    monkeypatch.setattr(texts.time, 'time', lambda: future)
    assert texts.history(ident) == []
    d = texts.detail(ident)
    texts.save(ident, '三十一天后', d['version'])
    assert len(texts.history(ident)) == 1
