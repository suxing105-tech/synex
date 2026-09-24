"""Local text documents. Files are authoritative; SQLite is a rebuildable search index.

Only explicitly associated files/directories are scanned. All writes use version
checks, snapshots and atomic replacement. Never fall back from trash to unlink.
"""
from __future__ import annotations

import codecs
import errno
import hashlib
import json
import os
import re
import stat
import tempfile
import threading
import time
import uuid
from functools import wraps
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from fastapi import HTTPException

from . import db
from .config import data_dir

EXTENSIONS = {'.txt', '.md', '.markdown', '.srt', '.vtt'}
MAX_BYTES = 8 * 1024 * 1024
LOCK = threading.RLock()


def serialized(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with LOCK:
            return fn(*args, **kwargs)
    return wrapped


def initialize(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS texts (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        filename TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '', encoding TEXT, mtime REAL NOT NULL DEFAULT 0,
        stamp TEXT NOT NULL DEFAULT '', created REAL NOT NULL, opened REAL NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]',
        missing INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS texts_mtime ON texts(mtime DESC);
    CREATE TABLE IF NOT EXISTS text_order (
        text_id INTEGER PRIMARY KEY REFERENCES texts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS text_roots (path TEXT PRIMARY KEY COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS text_history (
        id TEXT PRIMARY KEY, text_id INTEGER NOT NULL REFERENCES texts(id),
        created REAL NOT NULL, version TEXT NOT NULL, encoding TEXT, filename TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS text_history_document ON text_history(text_id,created DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(filename, body, tags, tokenize='trigram');
    ''')


def conn():
    return db.get_pool().main()


def safe_path(raw: str | Path) -> Path:
    p = Path(raw).expanduser().resolve()
    for part in p.parts:
        lower = part.lower()
        if (lower in {'.ssh', '.aws', '.git', 'node_modules'} or lower.startswith('.env')
                or any(s in lower for s in ('secret', 'token', 'password'))
                or lower.endswith(('.pem', '.key'))):
            raise ValueError('此路径属于排除的敏感文件或目录')
    return p


def document_path(raw) -> Path:
    p = safe_path(raw)
    if p.suffix.lower() not in EXTENSIONS:
        raise ValueError('支持 TXT、MD、Markdown、SRT、VTT')
    return p


def version(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_bytes(p: Path) -> bytes:
    if p.stat().st_size > MAX_BYTES:
        raise ValueError('文本超过 8 MB，请使用外部编辑器')
    with p.open('rb') as f:
        raw = f.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError('文本超过 8 MB，请使用外部编辑器')
    return raw


def decode(raw: bytes, chosen: str | None = None):
    bom = b''
    encoding = chosen
    for prefix, enc in ((codecs.BOM_UTF8, 'utf-8'), (codecs.BOM_UTF16_LE, 'utf-16-le'),
                        (codecs.BOM_UTF16_BE, 'utf-16-be')):
        if raw.startswith(prefix):
            bom, encoding = prefix, enc
            break
    if encoding and encoding not in {'utf-8', 'utf-16-le', 'utf-16-be', 'gb18030', 'big5'}:
        raise ValueError('不支持的编码')
    ambiguous = False
    try:
        body = raw[len(bom):].decode(encoding or 'utf-8', errors='strict')
        encoding = encoding or 'utf-8'
    except UnicodeError:
        if chosen or bom:
            raise ValueError('此编码无法无损读取，请选择其他编码')
        body = raw.decode('gb18030', errors='replace')
        encoding, ambiguous = None, True
    if '\x00' in body:
        raise ValueError('文件包含二进制内容，不能作为文本编辑')
    newline = '\r\n' if '\r\n' in body else '\r' if '\r' in body else '\n'
    return body.replace('\r\n', '\n').replace('\r', '\n'), encoding, bom, newline, ambiguous


def row(text_id: int):
    result = conn().execute('SELECT * FROM texts WHERE id=?', (text_id,)).fetchone()
    if not result:
        raise HTTPException(404, '文本不存在')
    return dict(result)


def sync_fts(r):
    c = conn()
    c.execute('DELETE FROM texts_fts WHERE rowid=?', (r['id'],))
    c.execute('INSERT INTO texts_fts(rowid,filename,body,tags) VALUES(?,?,?,?)',
              (r['id'], r['filename'], r['body'], r['tags']))


def index(p: Path, chosen: str | None = None):
    p = document_path(p)
    raw = read_bytes(p)
    c = conn()
    old = c.execute('SELECT * FROM texts WHERE path=?', (str(p),)).fetchone()
    body, encoding, _, _, ambiguous = decode(raw, chosen or (old['encoding'] if old else None))
    s = p.stat()
    with db.transaction() as c:
        c.execute('''INSERT INTO texts(path,filename,body,version,encoding,mtime,stamp,created)
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET filename=excluded.filename,
          body=excluded.body,version=excluded.version,encoding=excluded.encoding,
          mtime=excluded.mtime,stamp=excluded.stamp,missing=0,
          error=CASE WHEN texts.error LIKE '移动后引用维护失败%' THEN texts.error ELSE '' END ''',
          (str(p), p.name, body, version(raw), encoding, s.st_mtime,
           f'{s.st_mtime_ns}:{s.st_size}', s.st_ctime))
        r = dict(c.execute('SELECT * FROM texts WHERE path=?', (str(p),)).fetchone())
        sync_fts(r)
    ensure_folder_chain(p)
    return r


def ensure_folder_chain(p: Path):
    """Mirror subdirectories of explicitly associated text roots into the shared tree."""
    from . import repository
    roots = [Path(r['path']) for r in conn().execute('SELECT path FROM text_roots')]
    root = repository.find_watch_root(p, roots)
    if root is None:
        return
    current = root
    parent = None
    for part in (None, *p.parent.relative_to(root).parts):
        if part is not None:
            current /= part
        normalized = repository._normalize_path(current)
        found = conn().execute('SELECT id,is_system,parent_id FROM folders WHERE lower(replace(path,char(92),?))=lower(?)', ('/', normalized)).fetchone()
        if found:
            if part is not None and found['is_system'] and found['parent_id'] != parent:
                conn().execute('UPDATE folders SET parent_id=? WHERE id=?', (parent, found['id']))
            parent = found['id']
            continue
        folder = repository.folder_create(current.name, parent, is_system=True)
        conn().execute('UPDATE folders SET path=? WHERE id=?', (normalized, folder['id']))
        parent = folder['id']


def detail(text_id: int, encoding: str | None = None, opened=False):
    with LOCK:
        r = row(text_id)
        p = document_path(r['path'])
        raw = read_bytes(p)
        body, enc, bom, newline, ambiguous = decode(raw, encoding or r['encoding'])
        r = index(p, encoding)
        if opened:
            conn().execute('UPDATE texts SET opened=? WHERE id=?', (time.time(), text_id))
        return {**summary(r), 'body': body, 'version': version(raw), 'encoding': enc,
                'newline': {'\n': 'LF', '\r\n': 'CRLF', '\r': 'CR'}[newline],
                'bom': bool(bom), 'readonly': ambiguous or not os.access(p, os.W_OK),
                'needs_encoding': ambiguous}


def summary(r):
    return {k: r[k] for k in ('id', 'path', 'filename', 'mtime', 'created', 'opened',
                              'favorite', 'missing', 'error')} | {
        'format': Path(r['path']).suffix.lower()[1:], 'tags': json.loads(r['tags']),
        'excerpt': r['body'][:180]}


def candidates(paths):
    found, errors, roots = {}, [], []
    for raw in paths:
        try:
            p = safe_path(raw)
            if p.is_dir():
                roots.append(str(p))
                visited = set()
                for directory, dirs, files in os.walk(p, followlinks=False):
                    resolved = Path(directory).resolve()
                    if resolved in visited or not resolved.is_relative_to(p):
                        dirs[:] = []
                        continue
                    visited.add(resolved)
                    allowed = []
                    for name in dirs:
                        try:
                            sub = safe_path(Path(directory) / name)
                            if sub.is_relative_to(p) and sub not in visited and not (Path(directory) / name).is_symlink():
                                allowed.append(name)
                        except ValueError:
                            pass
                    dirs[:] = allowed
                    for name in files:
                        candidate = Path(directory) / name
                        if candidate.suffix.lower() in EXTENSIONS:
                            try:
                                candidate = document_path(candidate)
                                if candidate.is_relative_to(p):
                                    found[str(candidate)] = candidate
                            except ValueError:
                                pass
            else:
                p = document_path(p)
                if not p.is_file():
                    raise ValueError('文件不存在')
                found[str(p)] = p
        except (OSError, ValueError) as e:
            errors.append({'path': str(raw), 'reason': str(e)})
    return list(found.values()), errors, roots


def preview(paths):
    files, errors, roots = candidates(paths)
    counts = {ext[1:]: 0 for ext in sorted(EXTENSIONS)}
    for p in files:
        counts[p.suffix.lower()[1:]] += 1
    return {'total': len(files), 'formats': counts, 'errors': errors, 'roots': roots}


def associate(paths):
    from . import repository
    with LOCK:
        files, errors, roots = candidates(paths)
        for root in roots:
            conn().execute('INSERT OR IGNORE INTO text_roots(path) VALUES(?)', (root,))
            existing = conn().execute('SELECT id FROM folders WHERE lower(replace(path, char(92), ?))=lower(?)',
                                      ('/', Path(root).as_posix())).fetchone()
            if not existing:
                f = repository.folder_create(Path(root).name, None, is_system=True)
                conn().execute('UPDATE folders SET path=? WHERE id=?', (repository._normalize_path(Path(root)), f['id']))
        saved = []
        for p in files:
            try:
                saved.append(summary(index(p)))
            except (OSError, ValueError) as e:
                errors.append({'path': str(p), 'reason': str(e)})
        return {'saved': saved, 'errors': errors}


@serialized
def reorder(ids: list[int]):
    if len(ids) != len(set(ids)):
        raise ValueError('排序不能包含重复文本')
    c = conn()
    ordered = [r['id'] for r in c.execute('SELECT id FROM texts WHERE missing=0 ORDER BY '
        'COALESCE((SELECT position FROM text_order WHERE text_id=texts.id),2147483647),mtime DESC,id')]
    if not set(ids).issubset(ordered):
        raise ValueError('部分文本已移除，请刷新列表后重试')
    # Replace only the visible documents' slots; filtered/paginated documents keep their place.
    selected, replacement = set(ids), iter(ids)
    ordered = [next(replacement) if ident in selected else ident for ident in ordered]
    with c:
        c.executemany('INSERT INTO text_order(text_id,position) VALUES (?,?) '
                      'ON CONFLICT(text_id) DO UPDATE SET position=excluded.position',
                      [(ident, position) for position, ident in enumerate(ordered)])
    return {'ok': True}


def listing(q='', folder_id=None, view='all', format='', tag='', sort='mtime', offset=0, limit=100):
    clauses, args = ['missing=0'], []
    if folder_id is not None:
        folder = conn().execute('SELECT path FROM folders WHERE id=?', (folder_id,)).fetchone()
        if not folder or not folder['path']:
            return {'items': [], 'total': 0}
        prefix = str(Path(folder['path']).resolve()) + os.sep
        clauses.append('lower(substr(path,1,?))=lower(?)')
        args.extend((len(prefix), prefix))
    if view == 'favorite':
        clauses.append('favorite=1')
    if view == 'recent':
        clauses.append('opened>0')
    if format:
        clauses.append('lower(path) LIKE ?')
        args.append('%.' + format.lower())
    if tag:
        clauses.append('EXISTS (SELECT 1 FROM json_each(texts.tags) WHERE value=?)')
        args.append(tag)
    if q.strip():
        if len(q.strip()) >= 3:
            clauses.append('id IN (SELECT rowid FROM texts_fts WHERE texts_fts MATCH ?)')
            args.append('"' + q.strip().replace('"', '""') + '"')
        # instr deliberately supports short Chinese substrings and literal %/_ characters.
        clauses.append('(instr(lower(filename),lower(?))>0 OR instr(lower(body),lower(?))>0 OR instr(lower(tags),lower(?))>0)')
        args.extend([q.strip()] * 3)
    where = ' AND '.join(clauses)
    order = 'COALESCE((SELECT position FROM text_order WHERE text_id=texts.id),2147483647),mtime DESC' if sort == 'manual' else 'opened DESC' if view == 'recent' else {'mtime': 'mtime DESC', 'name': 'filename COLLATE NOCASE', 'created': 'created DESC'}.get(sort, 'mtime DESC')
    total = conn().execute(f'SELECT count(*) FROM texts WHERE {where}', args).fetchone()[0]
    items = []
    for r in conn().execute(f'SELECT * FROM texts WHERE {where} ORDER BY {order},id LIMIT ? OFFSET ?', [*args, limit, offset]):
        item = summary(r)
        at = r['body'].lower().find(q.strip().lower()) if q.strip() else -1
        if at >= 0:
            item['excerpt'] = r['body'][max(0, at - 35):at + 145]
        item['match_offset'] = max(0, at)
        items.append(item)
    return {'items': items, 'total': total}


def snapshot(r, raw, force=False):
    now = time.time()
    latest = conn().execute('SELECT * FROM text_history WHERE text_id=? ORDER BY created DESC LIMIT 1', (r['id'],)).fetchone()
    if not force and latest and now - latest['created'] < 300:
        return
    directory = data_dir() / 'text-history'
    directory.mkdir(parents=True, exist_ok=True)
    ident = uuid.uuid4().hex
    (directory / ident).write_bytes(raw)
    conn().execute('INSERT INTO text_history VALUES(?,?,?,?,?,?)',
        (ident, r['id'], now, version(raw), r['encoding'], r['filename']))
    for old in conn().execute('SELECT id FROM text_history WHERE created<?', (now - 30 * 86400,)).fetchall():
        (directory / old['id']).unlink(missing_ok=True)
        conn().execute('DELETE FROM text_history WHERE id=?', (old['id'],))


def atomic_write(p, raw, expected):
    if not p.stat().st_mode & stat.S_IWRITE:
        raise PermissionError('文件只读，未保存')
    fd, tmp = tempfile.mkstemp(prefix='.seekx-', suffix='.tmp', dir=p.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, stat.S_IMODE(p.stat().st_mode))
        if version(read_bytes(p)) != expected:
            raise HTTPException(409, '原文件已被其他程序修改，请解决冲突或另存副本')
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def save(text_id, body, expected, encoding=None, force_history=False):
    with LOCK:
        r = row(text_id)
        p = document_path(r['path'])
        old = read_bytes(p)
        if version(old) != expected:
            raise HTTPException(409, '原文件已被其他程序修改，请解决冲突或另存副本')
        old_body, enc, bom, newline, ambiguous = decode(old, encoding or r['encoding'])
        if ambiguous:
            raise ValueError('请先选择文件编码')
        # Preserve original line endings for unchanged lines, including mixed files.
        old_lines = old[len(bom):].decode(enc).splitlines(keepends=True)
        lines = body.replace('\r\n', '\n').replace('\r', '\n').splitlines(keepends=True)
        encoded_lines = []
        for i, line in enumerate(lines):
            if i < len(old_lines) and line.rstrip('\n') == old_lines[i].rstrip('\r\n'):
                ending = old_lines[i][len(old_lines[i].rstrip('\r\n')):]
                encoded_lines.append(line.rstrip('\n') + (ending or newline if line.endswith('\n') else ''))
            else:
                encoded_lines.append(line.replace('\n', newline))
        raw = bom + ''.join(encoded_lines).encode(enc, errors='strict')
        if len(raw) > MAX_BYTES:
            raise ValueError('文本超过 8 MB')
        if raw != old:
            snapshot(r | {'encoding': enc}, old, force=force_history)
            atomic_write(p, raw, expected)
        return detail(index(p, enc)['id'])


def create(directory, name, body='', folder_id=None):
    from .folder_storage import target_directory, valid_name
    with LOCK:
        directory = target_directory(folder_id) if folder_id is not None else safe_path(directory)
        if not directory.is_dir():
            raise ValueError('请选择已存在的保存文件夹')
        name = valid_name(name)
        p = document_path(directory / name)
        raw = body.encode('utf-8')
        if len(raw) > MAX_BYTES:
            raise ValueError('文本超过 8 MB')
        with p.open('xb') as f:
            f.write(raw)
        return detail(index(p)['id'], opened=True)


def metadata(text_id, favorite=None, tags=None):
    with LOCK:
        r = row(text_id)
        conn().execute('UPDATE texts SET favorite=?,tags=? WHERE id=?',
            (r['favorite'] if favorite is None else int(favorite),
             r['tags'] if tags is None else json.dumps(list(dict.fromkeys(t.strip() for t in tags if t.strip())), ensure_ascii=False), text_id))
        sync_fts(row(text_id))
        return summary(row(text_id))


def history(text_id):
    row(text_id)
    return [dict(r) for r in conn().execute('SELECT * FROM text_history WHERE text_id=? AND created>=? ORDER BY created DESC', (text_id, time.time() - 30 * 86400))]


def historical(text_id, ident):
    h = conn().execute('SELECT * FROM text_history WHERE text_id=? AND id=?', (text_id, ident)).fetchone()
    if not h:
        raise HTTPException(404, '历史版本不存在')
    raw = (data_dir() / 'text-history' / h['id']).read_bytes()
    return {'body': decode(raw, h['encoding'])[0], 'encoding': h['encoding'], 'created': h['created']}


def recycle_file(p):
    """IFileOperation: recycle-only + early failure, no permanent-delete fallback."""
    if os.name != 'nt':
        raise ValueError('当前平台没有可用的系统回收站接口，已停止删除')
    import ctypes
    from ctypes import wintypes
    if str(p).startswith('\\\\'):
        raise ValueError('网络路径无法保证回收站恢复，已停止删除')
    if ctypes.windll.kernel32.GetDriveTypeW(str(p.anchor)) != 3:
        raise ValueError('仅支持本地固定磁盘的回收站，已停止删除')
    class GUID(ctypes.Structure):
        _fields_ = [('a', wintypes.DWORD), ('b', wintypes.WORD), ('c', wintypes.WORD), ('d', ctypes.c_ubyte * 8)]
    def guid(value):
        return GUID.from_buffer_copy(uuid.UUID(value).bytes_le)
    def check(hr):
        if hr < 0:
            raise OSError(f'回收站操作失败 (HRESULT {hr & 0xffffffff:08x})，未执行永久删除')
    def method(pointer, slot, result, *args):
        table = ctypes.cast(pointer, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        return ctypes.WINFUNCTYPE(result, ctypes.c_void_p, *args)(table[slot])
    ole, shell = ctypes.OleDLL('ole32'), ctypes.WinDLL('shell32')
    initialized = ole.CoInitializeEx(None, 2)
    check(initialized)
    operation, item = ctypes.c_void_p(), ctypes.c_void_p()
    try:
        clsid = guid('3ad05575-8857-4850-9277-11b85bdb8e09')
        iid = guid('947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8')
        check(ole.CoCreateInstance(ctypes.byref(clsid), None, 1, ctypes.byref(iid), ctypes.byref(operation)))
        shell_iid = guid('43826d1e-e718-42ee-bc55-a1e261c37bfe')
        create_item = shell.SHCreateItemFromParsingName
        create_item.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
        create_item.restype = ctypes.c_long
        check(create_item(str(p), None, ctypes.byref(shell_iid), ctypes.byref(item)))
        flags = 0x00080000 | 0x00100000 | 0x00000400 | 0x00000010 | 0x00000004
        check(method(operation, 5, ctypes.c_long, wintypes.DWORD)(operation, flags))
        check(method(operation, 18, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)(operation, item, None))
        check(method(operation, 21, ctypes.c_long)(operation))
        aborted = wintypes.BOOL()
        check(method(operation, 22, ctypes.c_long, ctypes.POINTER(wintypes.BOOL))(operation, ctypes.byref(aborted)))
        if aborted.value or p.exists():
            raise OSError('回收站操作未完成，未执行永久删除')
    finally:
        if item.value:
            method(item, 2, wintypes.ULONG)(item)
        if operation.value:
            method(operation, 2, wintypes.ULONG)(operation)
        ole.CoUninitialize()


def trash(text_id, expected):
    with LOCK:
        r = row(text_id)
        p = document_path(r['path'])
        raw = read_bytes(p)
        if version(raw) != expected:
            raise HTTPException(409, '原文件已改变，请重新读取后删除')
        snapshot(r, raw, force=True)
        recycle_file(p)
        conn().execute('UPDATE texts SET missing=1 WHERE id=?', (text_id,))
        conn().execute('DELETE FROM texts_fts WHERE rowid=?', (text_id,))
        return {'ok': True}


LINK = re.compile(r'(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^\s)]+)(\))')


def rewrite_links(body, rewrite):
    """Keep examples inside inline/fenced code literal when moving files."""
    result, fence = [], ''
    for line in body.splitlines(keepends=True):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            if not fence:
                fence = marker[1]
            elif marker[1][0] == fence[0] and len(marker[1]) >= len(fence):
                fence = ''
            result.append(line)
        elif fence:
            result.append(line)
        else:
            pieces = re.split(r'(`+[^`]*`+)', line)
            result.append(''.join(piece if piece.startswith('`') else LINK.sub(rewrite, piece) for piece in pieces))
    return ''.join(result)


def link_path(source, link):
    link = unquote(link.strip('<>'))
    if link.startswith('file:'):
        parsed = urlparse(link)
        if parsed.netloc:
            return None
        return Path(parsed.path.lstrip('/') if os.name == 'nt' else parsed.path).resolve()
    if re.match(r'^[a-zA-Z][\w+.-]*:', link) or link.startswith(('#', '//')):
        return None
    return (source.parent / link).resolve()


def reference(source, target):
    try:
        return quote(os.path.relpath(target, source.parent).replace('\\', '/'), safe='/.-_~')
    except ValueError:
        return target.as_uri()


def remap(old: Path, new: Path):
    """Called after a successful physical move; document IDs and histories survive.

    Failed reference writes are visible on the document, never silently discarded.
    """
    old, new = old.resolve(), new.resolve()
    def mapped(p):
        return new / p.relative_to(old) if p == old or p.is_relative_to(old) else p
    with LOCK:
        for root in conn().execute('SELECT path FROM text_roots').fetchall():
            p = Path(root['path'])
            target = mapped(p)
            if target != p:
                conn().execute('UPDATE text_roots SET path=? WHERE path=?', (str(target), str(p)))
        for r in conn().execute('SELECT * FROM texts').fetchall():
            before = Path(r['path'])
            after = mapped(before)
            if after != before:
                conn().execute('UPDATE texts SET path=?,filename=? WHERE id=?', (str(after), after.name, r['id']))
            try:
                if after.suffix.lower() in {'.md', '.markdown'} and after.exists():
                    raw = read_bytes(after)
                    body, enc, _, _, ambiguous = decode(raw, r['encoding'])
                    def rewrite(m):
                        dest = link_path(before, m[2])
                        if dest is None:
                            return m[0]
                        target = mapped(dest)
                        return m[1] + reference(after, target) + m[3] if before != after or target != dest else m[0]
                    updated = rewrite_links(body, rewrite)
                    if updated != body:
                        save(r['id'], updated, version(raw), enc, force_history=True)
                index(after, r['encoding'])
            except (OSError, ValueError, HTTPException) as e:
                conn().execute('UPDATE texts SET error=? WHERE id=?', (f'移动后引用维护失败：{e}', r['id']))


def move(text_id, directory, name, expected):
    from .folder_storage import valid_name
    with LOCK:
        r = row(text_id)
        old = document_path(r['path'])
        if version(read_bytes(old)) != expected:
            raise HTTPException(409, '原文件已改变，请重新读取后移动')
        new = document_path((safe_path(directory) if directory else old.parent) / valid_name(name or old.name))
        if old == new:
            return detail(text_id)
        if new.exists():
            raise ValueError('目标文件已存在，不会覆盖')
        # Windows rename refuses existing destinations. Cross-volume moves use exclusive copy.
        try:
            old.rename(new)
        except OSError as e:
            if e.errno != errno.EXDEV and getattr(e, 'winerror', None) != 17:
                raise
            raw = read_bytes(old)
            created = False
            try:
                with new.open('xb') as output:
                    created = True
                    output.write(raw); output.flush(); os.fsync(output.fileno())
                if version(read_bytes(old)) != expected:
                    raise HTTPException(409, '原文件在移动期间发生变化，已取消移动')
                old.unlink()
            except Exception:
                if created:
                    new.unlink(missing_ok=True)
                raise
        remap(old, new)
        return detail(text_id)


def asset(text_id, href):
    source = Path(row(text_id)['path'])
    p = link_path(source, href)
    if p is None:
        raise HTTPException(400, '只允许本地素材引用')
    p = safe_path(p)
    # Only explicitly indexed media can be served. No arbitrary file read endpoint.
    from .repository import _normalize_path
    r = conn().execute('SELECT id,kind FROM images WHERE lower(replace(path,char(92),?))=lower(?)', ('/', _normalize_path(p))).fetchone()
    if not r or not p.is_file():
        raise HTTPException(404, '素材失效或未加入图库，请重新定位')
    return p, dict(r)


def reconcile():
    changed = False
    with LOCK:
        paths, _, _ = candidates([r['path'] for r in conn().execute('SELECT path FROM text_roots')])
        known = {r['path']: dict(r) for r in conn().execute('SELECT * FROM texts')}
        all_paths = {str(p): p for p in paths}
        all_paths.update({p: Path(p) for p in known})
        for key, p in all_paths.items():
            r = known.get(key)
            try:
                s = p.stat()
                stamp = f'{s.st_mtime_ns}:{s.st_size}'
                if not r or r['stamp'] != stamp or r['missing']:
                    index(p)
                    changed = True
            except FileNotFoundError:
                if r and not r['missing']:
                    conn().execute('UPDATE texts SET missing=1 WHERE id=?', (r['id'],))
                    conn().execute('DELETE FROM texts_fts WHERE rowid=?', (r['id'],))
                    changed = True
            except (OSError, ValueError) as e:
                if r and r['error'] != str(e):
                    conn().execute('UPDATE texts SET error=? WHERE id=?', (str(e), r['id']))
                    changed = True
    return changed
