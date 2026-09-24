"""Text APIs; all file mutations are version checked by the service."""
from pathlib import Path
from functools import wraps

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import texts

router = APIRouter(prefix='/api/texts', tags=['texts'])


def errors(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except FileNotFoundError as e:
            raise HTTPException(404, '文件或目录不存在，编辑内容仍可另存副本') from e
        except (OSError, ValueError, UnicodeError) as e:
            raise HTTPException(400, str(e)) from e
    return call


class Paths(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=100)


class Reorder(BaseModel):
    ids: list[int] = Field(min_length=2, max_length=10000)


@router.post('/reorder')
@errors
def reorder(payload: Reorder):
    return texts.reorder(payload.ids)


class Create(BaseModel):
    directory: str = ''
    folder_id: int | None = None
    name: str
    body: str = Field(default='', max_length=texts.MAX_BYTES)


class Save(BaseModel):
    body: str = Field(max_length=texts.MAX_BYTES)
    version: str
    encoding: str | None = None
    resolving_conflict: bool = False


class Meta(BaseModel):
    favorite: bool | None = None
    tags: list[str] | None = Field(default=None, max_length=100)


class Version(BaseModel):
    version: str


class Move(Version):
    directory: str = ''
    name: str = ''


@router.get('')
@errors
def listing(q: str = '', folder_id: int | None = None, view: str = 'all', format: str = '',
            tag: str = '', sort: str = 'mtime', offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500)):
    return texts.listing(q, folder_id, view, format, tag, sort, offset, limit)


@router.post('/preview')
@errors
def preview(payload: Paths):
    return texts.preview(payload.paths)


@router.post('/associate')
@errors
def associate(payload: Paths):
    return texts.associate(payload.paths)


@router.post('')
@errors
def create(payload: Create):
    return texts.create(payload.directory, payload.name, payload.body, payload.folder_id)


@router.get('/{text_id}')
@errors
def detail(text_id: int, encoding: str | None = None, opened: bool = False):
    return texts.detail(text_id, encoding, opened)


@router.put('/{text_id}')
@errors
def save(text_id: int, payload: Save):
    return texts.save(text_id, payload.body, payload.version, payload.encoding, payload.resolving_conflict)


@router.patch('/{text_id}')
@errors
def metadata(text_id: int, payload: Meta):
    return texts.metadata(text_id, payload.favorite, payload.tags)


@router.post('/{text_id}/move')
@errors
def move(text_id: int, payload: Move):
    return texts.move(text_id, payload.directory, payload.name, payload.version)


@router.post('/{text_id}/trash')
@errors
def trash(text_id: int, payload: Version):
    return texts.trash(text_id, payload.version)


@router.get('/{text_id}/history')
@errors
def history(text_id: int):
    return texts.history(text_id)


@router.get('/{text_id}/history/{ident}')
@errors
def historical(text_id: int, ident: str):
    return texts.historical(text_id, ident)


@router.post('/{text_id}/history/{ident}/restore')
@errors
def restore(text_id: int, ident: str, payload: Version):
    h = texts.historical(text_id, ident)
    return texts.save(text_id, h['body'], payload.version, force_history=True)


@router.get('/{text_id}/asset')
@errors
def asset(text_id: int, href: str):
    path, _ = texts.asset(text_id, href)
    return FileResponse(path, headers={'X-Content-Type-Options': 'nosniff'})


@router.get('/{text_id}/asset-info')
@errors
def asset_info(text_id: int, href: str):
    target = texts.link_path(Path(texts.row(text_id)['path']), href)
    if target is not None and target.suffix.lower() in texts.EXTENSIONS:
        target = texts.document_path(target)
        linked = texts.conn().execute('SELECT id FROM texts WHERE path=? AND missing=0', (str(target),)).fetchone()
        if linked and target.is_file():
            return {'id': linked['id'], 'kind': 'text'}
    _, info = texts.asset(text_id, href)
    return info


@router.post('/{text_id}/reveal')
@errors
def reveal(text_id: int):
    import os
    import subprocess
    p = texts.document_path(texts.row(text_id)['path'])
    if not p.exists():
        raise HTTPException(404, '原文件不存在')
    if os.name == 'nt':
        subprocess.Popen(['explorer.exe', '/select,', str(p)])
    else:
        raise HTTPException(400, '请复制文件路径后在文件管理器中打开')
    return {'ok': True}


@router.get('/{text_id}/reference/{image_id}')
@errors
def reference(text_id: int, image_id: int):
    r = texts.conn().execute('SELECT path,kind,filename FROM images WHERE id=?', (image_id,)).fetchone()
    if not r:
        raise HTTPException(404, '素材不存在')
    href = texts.reference(Path(texts.row(text_id)['path']), Path(r['path']))
    label = r['filename'].replace('[', '').replace(']', '').replace('\n', '')
    return {'markdown': ('!' if r['kind'] == 'image' else '') + f'[{label}]({href})',
            'href': href, 'portable': not href.startswith('file:')}
