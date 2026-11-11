import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { get } from "svelte/store";
import Feed from "../components/Feed.svelte";
import { imagesApi, itemsApi } from "../lib/api";
import {
  activeKind,
  feedItems,
  feedLoading,
  folderId,
  kindFilter,
  scope,
  selectFolder,
  switchType,
} from "../lib/stores";

/**
 * 「选了文件夹就必须看到 全部/图片/视频/音频/文本 菜单」这条约定的用例。
 *
 * 老规矩是菜单只在 scope=all 出现，于是侧栏停在「全部图片」时点开自己的文件夹，
 * 菜单整条消失 —— 同一个文件夹点进去有没有菜单，取决于上一次点的是侧栏哪一行。
 * 现在收口成三条：选文件夹只换范围不换类型（selectFolder）；快捷键在文件夹里换的是
 * 菜单而不是口径（switchType）；菜单在「统一流 或 选了文件夹」时一定出现。
 */
vi.mock("../lib/api", () => ({
  itemsApi: { list: vi.fn(async () => ({ items: [], total: 0, counts: { image: 0, video: 0, audio: 0, text: 0 } })) },
  imagesApi: { list: vi.fn(async () => ({ items: [], total: 0 })), detail: vi.fn() },
  foldersApi: { tree: vi.fn(async () => []) },
  statsApi: { get: vi.fn() },
  scanApi: { progress: vi.fn() },
  comfyuiApi: {},
}));

/** feed 重拉是 200ms 防抖的，等过它再断言请求参数。 */
async function settled() {
  await new Promise((resolve) => setTimeout(resolve, 320));
}

beforeEach(() => {
  vi.clearAllMocks();
  scope.set("all");
  folderId.set(null);
  kindFilter.set("all");
  feedItems.set([]);
  feedLoading.set(false);
});

afterEach(() => {
  cleanup();
  scope.set("all");
  folderId.set(null);
  kindFilter.set("all");
});

describe("selectFolder：换范围，不换类型", () => {
  it("从「全部图片」点进文件夹 → 走统一流、菜单仍亮着图片、folder 换过去", () => {
    scope.set("image");
    selectFolder(7);
    expect(get(scope)).toBe("all");
    expect(get(kindFilter)).toBe("image");
    expect(get(folderId)).toBe(7);
    expect(get(activeKind)).toBe("image");
  });

  it("从「所有素材」点进文件夹 → 菜单上原有的类型偏好原样保留", () => {
    kindFilter.set("audio");
    selectFolder(3);
    expect(get(scope)).toBe("all");
    expect(get(kindFilter)).toBe("audio");
    expect(get(folderId)).toBe(3);
  });

  it("重拉真的换成「这个文件夹的这一类」，不是全库、也不再走单一口径那个接口", async () => {
    scope.set("image");
    selectFolder(7);
    await settled();
    expect(imagesApi.list).not.toHaveBeenCalled();
    const query = vi.mocked(itemsApi.list).mock.calls.at(-1)?.[0];
    expect(query?.folder_id).toBe(7);
    expect(query?.kinds).toBe("image");
  });
});

describe("switchType：快捷键在文件夹里只换菜单", () => {
  it("选了文件夹时按 I/V/A/T 换的是菜单，文件夹留在原地", () => {
    selectFolder(7);
    switchType("video");
    expect(get(folderId)).toBe(7);
    expect(get(scope)).toBe("all");
    expect(get(kindFilter)).toBe("video");
  });

  it("没选文件夹时仍旧换侧栏口径（原行为不变）", () => {
    switchType("audio");
    expect(get(scope)).toBe("audio");
    expect(get(folderId)).toBeNull();
  });
});

describe("工具栏：选了文件夹菜单一定在", () => {
  const props = { selectedId: null, lightboxOpen: false, lightboxIndex: 0 };

  it("口径停在「全部图片」+ 选了文件夹：五颗 chip 仍在（用户圈的右上角空白）", () => {
    scope.set("image");
    folderId.set(7);
    const { container } = render(Feed, props);
    expect(container.querySelectorAll(".type-chips .chip")).toHaveLength(5);
  });

  it("没选文件夹的纯全库口径：菜单继续让位给侧栏那五行", () => {
    scope.set("video");
    const { container } = render(Feed, props);
    expect(container.querySelector(".type-chips")).toBeNull();
  });
});
