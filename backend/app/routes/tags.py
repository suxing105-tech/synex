"""/api/tags 路由。"""
from __future__ import annotations

from fastapi import APIRouter

from .. import repository

router = APIRouter(prefix="/api/tags", tags=["tags"])


@router.get("")
def list_tags():
    return repository.tag_list()
