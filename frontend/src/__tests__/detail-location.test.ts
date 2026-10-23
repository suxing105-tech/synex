import { describe, expect, it, vi, afterEach } from "vitest";
import { get } from "svelte/store";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { imagesApi } from "../lib/api";
import { selectedDetail, refreshSelectedDetail } from "../lib/stores";
import type { ImageDetail } from "../lib/types";

// 「所属文件夹 = 文件真实位置」这条链路的另外两环：
// 1) DetailPanel 把 d.path 和 reveal/复制回调一起交给 MetadataCard（图片、视频都要有）；
// 2) 文件被真实移动后，store 负责重拉详情，位置行才不会停在旧目录。

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, "..", "components", "DetailPanel.svelte"), "utf8");

vi.mock("../lib/api", () => ({
  imagesApi: { detail: vi.fn(), list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
  foldersApi: { tree: vi.fn().mockResolvedValue([]) },
  statsApi: { get: vi.fn().mockResolvedValue({ total_images: 0, favorites: 0, folders: 0 }) },
  scanApi: { progress: vi.fn() },
}));

function detail(id: number, path: string): ImageDetail {
  return { id, path, filename: path.split("/").pop() || "" } as ImageDetail;
}

afterEach(() => {
  vi.clearAllMocks();
  selectedDetail.set(null);
});

describe("DetailPanel 位置接线", () => {
  it("图片和视频两个分支都把 path 与 reveal/复制回调传给 MetadataCard", () => {
    const videoIdx = raw.indexOf('{#if d.kind === "video"}');
    const elseIdx = raw.indexOf("{:else}", videoIdx);
    expect(videoIdx).toBeGreaterThan(0);
    expect(elseIdx).toBeGreaterThan(videoIdx);
    const videoBranch = raw.slice(videoIdx, elseIdx);
    expect(videoBranch).toContain("path={d.path}");
    expect(videoBranch).toContain("onRevealLocation={revealLocation}");
    expect(videoBranch).toContain("onCopyLocation={copyLocation}");
    expect(raw.slice(elseIdx)).toContain("path={d.path}");
    expect(raw.slice(elseIdx)).toContain("onRevealLocation={revealLocation}");
    expect(raw.slice(elseIdx)).toContain("onCopyLocation={copyLocation}");
  });

  it("点击位置先走桌面壳（才能让资源管理器盖在应用上），浏览器版才回退后端 reveal", () => {
    // 桌面版带 path 走 reveal_path 命令；后端接口只作为浏览器端的回退保留。
    expect(raw).toContain("revealInShell(d.path, true, () => imagesApi.reveal(d.id))");
    const revealBody = raw.slice(raw.indexOf("async function revealLocation"));
    expect(revealBody.slice(0, 900)).toContain("await refreshSelectedDetail()");
  });

  it("复制的是所在文件夹路径（Windows 反斜杠），不是文件全路径", () => {
    expect(raw).toContain('copy(nativePath(parentDirectory(d.path)), "文件夹路径")');
  });
});

describe("refreshSelectedDetail", () => {
  it("没有选中项 → 不发请求", async () => {
    await refreshSelectedDetail();
    expect(imagesApi.detail).not.toHaveBeenCalled();
  });

  it("批量移动只重拉正打开的那一张", async () => {
    selectedDetail.set(detail(7, "C:/SeekX-Data/folders/影驰/a.png"));
    await refreshSelectedDetail([1, 2, 3]);
    expect(imagesApi.detail).not.toHaveBeenCalled();

    vi.mocked(imagesApi.detail).mockResolvedValue(detail(7, "C:/SeekX-Data/folders/HOF/b.png"));
    await refreshSelectedDetail([7]);
    expect(imagesApi.detail).toHaveBeenCalledWith(7);
    expect(get(selectedDetail)?.path).toBe("C:/SeekX-Data/folders/HOF/b.png");
  });

  it("不传 ids 时无条件重拉（reveal 失败等场景）", async () => {
    selectedDetail.set(detail(9, "C:/SeekX-Data/inbox/a.png"));
    vi.mocked(imagesApi.detail).mockResolvedValue(detail(9, "C:/SeekX-Data/folders/HOF/a.png"));
    await refreshSelectedDetail();
    expect(get(selectedDetail)?.path).toBe("C:/SeekX-Data/folders/HOF/a.png");
  });

  it("文件被移走导致重拉失败 → 保留上一次已知位置", async () => {
    selectedDetail.set(detail(11, "C:/SeekX-Data/folders/影驰/a.png"));
    vi.mocked(imagesApi.detail).mockRejectedValue(new Error("文件不存在"));
    await refreshSelectedDetail([11]);
    expect(get(selectedDetail)?.path).toBe("C:/SeekX-Data/folders/影驰/a.png");
  });

  it("重拉期间换了选中项 → 旧响应不许覆盖新选中项", async () => {
    selectedDetail.set(detail(21, "C:/a.png"));
    let resolve!: (value: ImageDetail) => void;
    vi.mocked(imagesApi.detail).mockImplementationOnce(
      () => new Promise((r) => { resolve = r; }),
    );
    const request = refreshSelectedDetail();
    selectedDetail.set(detail(22, "C:/b.png"));
    resolve(detail(21, "C:/moved.png"));
    await request;
    expect(get(selectedDetail)?.id).toBe(22);
  });
});