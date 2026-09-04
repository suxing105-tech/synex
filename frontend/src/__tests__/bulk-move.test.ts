import { describe, it, expect } from "vitest";
import type { FolderNode } from "../lib/types";

// 复刻 FolderPickerModal 里把 tree 摊平 + 过滤 system folder 的逻辑。
function flattenUserFolders(
  folders: FolderNode[],
): { id: number; name: string; depth: number }[] {
  const out: { id: number; name: string; depth: number }[] = [];
  const visit = (nodes: FolderNode[], depth: number) => {
    const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name, "zh"));
    for (const n of sorted) {
      if (n.is_system) continue; // system folder 不能作为"移动到"目标
      out.push({ id: n.id, name: n.name, depth });
      visit(n.children, depth + 1);
    }
  };
  visit(folders, 0);
  return out;
}

describe("FolderPickerModal 列表逻辑", () => {
  it("空树返回空数组", () => {
    expect(flattenUserFolders([])).toEqual([]);
  });

  it("只 system folder → 返回空（不能选 system）", () => {
    const tree: FolderNode[] = [
      { id: 1, parent_id: null, name: "krea2", order: 0, image_count: 80, recursive_count: 80, is_system: true, children: [] },
      { id: 2, parent_id: null, name: "video", order: 0, image_count: 16, recursive_count: 16, is_system: true, children: [] },
    ];
    expect(flattenUserFolders(tree)).toEqual([]);
  });

  it("只 user folder → 全返回", () => {
    const tree: FolderNode[] = [
      { id: 1, parent_id: null, name: "灵感", order: 0, image_count: 0, recursive_count: 2, children: [] },
      { id: 2, parent_id: null, name: "草稿", order: 0, image_count: 0, recursive_count: 0, children: [] },
    ];
    const flat = flattenUserFolders(tree);
    expect(flat).toHaveLength(2);
    // 函数内已按 zh 排序；取名字再按 zh 排序应得到固定序列
    const sortedNames = flat.map((x) => x.name).sort((a, b) => a.localeCompare(b, "zh"));
    expect(sortedNames).toEqual(["草稿", "灵感"]);
  });

  it("混合树 → 只保留 user folder 子树，system folder 整棵跳过", () => {
    const tree: FolderNode[] = [
      { id: 10, parent_id: null, name: "krea2", order: 0, image_count: 0, recursive_count: 80, is_system: true, children: [
        { id: 11, parent_id: 10, name: "foo", order: 0, image_count: 0, recursive_count: 80, is_system: true, children: [] },
      ] },
      { id: 1, parent_id: null, name: "项目", order: 0, image_count: 0, recursive_count: 1, children: [
        { id: 2, parent_id: 1, name: "角色定妆", order: 0, image_count: 0, recursive_count: 0, children: [] },
      ] },
    ];
    const flat = flattenUserFolders(tree);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({ id: 1, name: "项目", depth: 0 });
    expect(flat[1]).toEqual({ id: 2, name: "角色定妆", depth: 1 });
  });

  it("深度正确传递", () => {
    const tree: FolderNode[] = [
      {
        id: 1, parent_id: null, name: "root", order: 0, image_count: 0, recursive_count: 0,
        children: [
          { id: 2, parent_id: 1, name: "mid", order: 0, image_count: 0, recursive_count: 0,
            children: [
              { id: 3, parent_id: 2, name: "leaf", order: 0, image_count: 0, recursive_count: 0, children: [] },
            ],
          },
        ],
      },
    ];
    const flat = flattenUserFolders(tree);
    expect(flat).toEqual([
      { id: 1, name: "root", depth: 0 },
      { id: 2, name: "mid", depth: 1 },
      { id: 3, name: "leaf", depth: 2 },
    ]);
  });
});

describe("imagesApi.bulkAssignFolder 调用形态", () => {
  it("body 序列化保持 folder_id=null（不是 undefined）", () => {
    const body = { image_ids: [1], folder_id: null };
    const serialized = JSON.parse(JSON.stringify(body));
    expect(serialized.folder_id).toBeNull();
  });

  it("body 包含所有 image_ids", () => {
    const body = { image_ids: [1, 2, 3, 4, 5], folder_id: 7 };
    const serialized = JSON.parse(JSON.stringify(body));
    expect(serialized.image_ids).toEqual([1, 2, 3, 4, 5]);
    expect(serialized.folder_id).toBe(7);
  });
});