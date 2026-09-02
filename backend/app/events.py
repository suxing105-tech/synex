"""WebSocket 事件总线 + 广播。

所有路由产生的实时事件通过 ``bus.publish`` 推入；订阅者通过 ``bus.subscribe`` 拿
到自己的 ``asyncio.Queue``。
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

log = logging.getLogger(__name__)


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._lock = asyncio.Lock()

    async def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._subs.add(q)
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._subs.discard(q)

    async def publish(self, payload: dict) -> None:
        async with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                log.warning("ws queue full, drop event %s", payload.get("type"))


_BUS: EventBus | None = None


def get_bus() -> EventBus:
    global _BUS
    if _BUS is None:
        _BUS = EventBus()
    return _BUS
