import { writable } from "svelte/store";
import type { FeedSort } from "./types";

/**
 * 素材流按什么排：文件名，还是修改时间（新的在前）。
 *
 * 2026-11-24 苏醒要求把排序做进卡片右键菜单的「排序」子菜单，图片 / 视频 / 音频 / 文本四类卡都有。
 * 0.2.22 撤掉的是**工具栏**上那颗排序控件，那条口径仍然有效（工具栏仍然不放第二个排序入口），
 * 后端的 sort 参数与 name_asc 分支一直留着，这一轮只是把入口接回来，不是把它复活成工具栏控件。
 *
 * 全站一个值，不分口径：四种卡共用同一张网格，换一行侧栏就换个顺序，更容易看着像 bug。
 * 按时间恒为「新的在前」，不做升降切换——菜单里点两下才换方向，不如把两项摊开来得明白。
 */
const STORAGE_KEY = "seekx.feed-sort.v1";
const DEFAULT_SORT: FeedSort = "mtime_desc";

/**
 * 「排序」子菜单的唯一真源：数组顺序＝菜单顺序，label＝菜单文案。
 * 媒体卡与文本卡两处菜单共用这一份，两边才不会长得不一样。
 */
export const FEED_SORT_OPTIONS: readonly { value: FeedSort; label: string }[] = [
  { value: "name_asc", label: "按名称排序" },
  { value: "mtime_desc", label: "按时间排序" },
];

function isFeedSort(value: unknown): value is FeedSort {
  return value === "name_asc" || value === "mtime_desc";
}

/** 读档只认那两个值：手改过 localStorage 或以后改了取值，都回落默认，不把脏值送进请求。 */
function readStored(): FeedSort {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isFeedSort(saved) ? saved : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT; // 无痕模式：用内存值，不炸界面
  }
}

export const feedSort = writable<FeedSort>(readStored());

/**
 * 只有用户在菜单里真的选过一次才落盘。
 * 单纯 store.set（测试、临时切换）不写存储 —— 上一版 card-title 那条就是栽在「一订阅就写盘」，
 * 写进去之后翻默认值对老用户再也不生效。
 */
export function setFeedSort(sort: FeedSort): void {
  feedSort.set(sort);
  try {
    localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    /* 落不了盘就算了，本次会话内照样生效 */
  }
}
