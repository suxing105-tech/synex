import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/svelte";
import MetadataCard from "../components/MetadataCard.svelte";
import type { FolderNode } from "../lib/types";

// 「所属文件夹」现在显示文件真实所在目录：看得见路径、点得开、移动后跟着变。

const userFolder: FolderNode = {
  id: 15,
  parent_id: null,
  name: "影驰",
  order: 0,
  counts: { image: 3, video: 0, audio: 0, text: 0 },
  total: 3,
  path: "C:/SeekX-Data/folders/影驰",
  children: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("MetadataCard 位置行", () => {
  it("显示真实所在目录，而不是只有文件夹名", () => {
    const { getByText, queryByText } = render(MetadataCard, {
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "C:/SeekX-Data/folders/影驰/image.png",
    });
    expect(getByText("C:\\SeekX-Data\\folders\\影驰")).toBeTruthy();
    expect(queryByText("影驰")).toBeNull();
  });

  it("tooltip 给完整路径，点击触发打开所在文件夹", async () => {
    const onRevealLocation = vi.fn();
    const { getByLabelText } = render(MetadataCard, {
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "C:/SeekX-Data/folders/影驰/image.png",
      onRevealLocation,
    });
    const button = getByLabelText("打开所在文件夹");
    expect(button.getAttribute("title")).toBe(
      "打开所在文件夹：C:\\SeekX-Data\\folders\\影驰",
    );
    await fireEvent.click(button);
    expect(onRevealLocation).toHaveBeenCalledTimes(1);
  });

  it("hover 的复制按钮复制所在文件夹路径", async () => {
    const onCopyLocation = vi.fn();
    const { getByLabelText } = render(MetadataCard, {
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "C:/SeekX-Data/folders/影驰/image.png",
      onCopyLocation,
    });
    await fireEvent.click(getByLabelText("复制文件夹路径"));
    expect(onCopyLocation).toHaveBeenCalledTimes(1);
  });

  it("监听目录里的长路径中间省略，末级目录仍可见", () => {
    const long =
      "C:/Users/Administrator/Documents/ChatGPT/产品广告宣传片/materials/tvc-director-worktree/references/clip.mp4";
    const { getByText } = render(MetadataCard, {
      tags: [],
      folderIds: [],
      folders: [],
      path: long,
    });
    const shown = getByText(/references$/);
    expect(shown.textContent).toContain("…");
  });

  it("拿不到路径时退回库内文件夹名 chips", () => {
    const { getByText, queryByText } = render(MetadataCard, {
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "",
    });
    expect(getByText("影驰")).toBeTruthy();
    expect(queryByText((text) => text.includes("SeekX-Data"))).toBeNull();
  });

  it("既没有路径也没有文件夹 → 说明位置未知", () => {
    const { getByText } = render(MetadataCard, {
      tags: [],
      folderIds: [],
      folders: [],
      path: "",
    });
    expect(getByText("位置未知（文件可能已被移动或删除）")).toBeTruthy();
  });

  it("路径变了就是新目录（移动后 detail 重拉即生效）", () => {
    const { getByText, rerender } = render(MetadataCard, {
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "C:/SeekX-Data/folders/影驰/image.png",
    });
    expect(getByText("C:\\SeekX-Data\\folders\\影驰")).toBeTruthy();
    rerender({
      tags: [],
      folderIds: [15],
      folders: [userFolder],
      path: "C:/SeekX-Data/folders/HOF_1/产品图/image.png",
    });
    expect(getByText("C:\\SeekX-Data\\folders\\HOF_1\\产品图")).toBeTruthy();
  });
});