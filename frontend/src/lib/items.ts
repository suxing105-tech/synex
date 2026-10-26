import type { ItemSummary, MediaFeedItem, Scope, TextFeedItem } from "./types";

/**
 * 统一流的身份约定。
 *
 * texts 与 images 各有各的自增 id，同一个数字能同时指向一篇文章和一张图，
 * 所以 DOM key、masonry key 和选区映射都必须走 itemUid，不能裸用 id。
 */
export function itemUid(item: Pick<ItemSummary, "item_type" | "id">): string {
  return `${item.item_type}:${item.id}`;
}

/**
 * 只有文本是「另一种东西」：缺 item_type 的行按媒体处理，
 * 这样单一类型的 feed 响应（没有混排语义）也能直接进同一条渲染链。
 */
export function isMediaItem(item: ItemSummary): item is MediaFeedItem {
  return item.item_type !== "text";
}

export function isTextItem(item: ItemSummary): item is TextFeedItem {
  return item.item_type === "text";
}

export function mediaOnly(items: ItemSummary[]): MediaFeedItem[] {
  return items.filter(isMediaItem);
}

export function mediaIndexOf(items: ItemSummary[], id: number): number {
  const media = mediaOnly(items);
  return media.findIndex((item) => item.id === id);
}

/** 当前流里出现了哪几类素材（用于选区文案与 chips 计数）。 */
export function kindsIn(items: ItemSummary[]): Scope[] {
  const seen = new Set<Scope>();
  for (const item of items) seen.add(item.kind);
  return [...seen];
}

/** 侧栏 scope → 该 scope 对应的唯一 kind（all 没有唯一 kind，返回 null）。 */
export function scopeToKind(scope: Scope): Scope | null {
  return scope === "all" ? null : scope;
}