import { describe, it, expect } from "vitest";
import type { FolderNode } from "../lib/types";

// 复刻 FolderTree.svelte 里 userFolders / systemFolders 的拆分逻辑。
// 实际 svelte 文件用 $derived，测试里把逻辑抽成纯函数便于断言。
function splitBySystem(folders: FolderNode[]): { user: FolderNode[]; system: FolderNode[] } {
  return {
    user: folders.filter((f) => !f.is_system),
    system: folders.filter((f) => !!f.is_system),
  };
}

function flat(nodes: FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  for (const n of nodes) {
    out.push(n);
    out.push(...flat(n.children));
  }
  return out;
}

describe("system folder 树拆分", () => {
  it("空树 → user/system 都空", () => {
    const { user, system } = splitBySystem([]);
    expect(user).toEqual([]);
    expect(system).toEqual([]);
  });

  it("只 user folder → 都进 user", () => {
    const tree: FolderNode[] = [
      {
        id: 1,
        parent_id: null,
        name: "灵感",
        order: 0,
        image_count: 3,
        recursive_count: 3,
        children: [],
      },
    ];
    const { user, system } = splitBySystem(tree);
    expect(user).toHaveLength(1);
    expect(system).toEqual([]);
    expect(user[0].name).toBe("灵感");
  });

  it("只 system folder → 都进 system", () => {
    const tree: FolderNode[] = [
      {
        id: 10,
        parent_id: null,
        name: "krea2",
        order: 0,
        image_count: 0,
        recursive_count: 81,
        is_system: true,
        path: "D:/ComfyUI/output/krea2",
        children: [],
      },
    ];
    const { user, system } = splitBySystem(tree);
    expect(user).toEqual([]);
    expect(system).toHaveLength(1);
    expect(system[0].is_system).toBe(true);
    expect(system[0].path).toContain("krea2");
  });

  it("混合树 → 按根 is_system 正确分流", () => {
    const tree: FolderNode[] = [
      {
        id: 1,
        parent_id: null,
        name: "灵感",
        order: 0,
        image_count: 0,
        recursive_count: 2,
        children: [
          {
            id: 2,
            parent_id: 1,
            name: "草稿",
            order: 0,
            image_count: 2,
            recursive_count: 2,
            children: [],
          },
        ],
      },
      {
        id: 10,
        parent_id: null,
        name: "krea2",
        order: 1,
        image_count: 5,
        recursive_count: 10,
        is_system: true,
        path: "D:/ComfyUI/output/krea2",
        children: [
          {
            id: 11,
            parent_id: 10,
            name: "foo",
            order: 0,
            image_count: 5,
            recursive_count: 5,
            is_system: true,
            path: "D:/ComfyUI/output/krea2/foo",
            children: [],
          },
        ],
      },
      {
        id: 20,
        parent_id: null,
        name: "Audio",
        order: 2,
        image_count: 2,
        recursive_count: 2,
        is_system: true,
        path: "D:/ComfyUI/output/Audio",
        children: [],
      },
    ];
    const { user, system } = splitBySystem(tree);
    expect(user).toHaveLength(1);
    expect(user[0].name).toBe("灵感");
    expect(user[0].children).toHaveLength(1); // 嵌套子 user folder 一起保留
    expect(system).toHaveLength(2);
    const sysNames = system.map((n) => n.name);
    expect(sysNames).toContain("krea2");
    expect(sysNames).toContain("Audio");
    // krea2 的子节点（foo）一并跟着父节点进 system
    const krea2 = system.find((n) => n.name === "krea2");
    expect(krea2?.children).toHaveLength(1);
    expect(krea2?.children[0].name).toBe("foo");
    expect(krea2?.children[0].is_system).toBe(true);
  });

  it("扁平化后统计：system folder 的图片应来自 system folder 链", () => {
    const tree: FolderNode[] = [
      {
        id: 10,
        parent_id: null,
        name: "krea2",
        order: 0,
        image_count: 0,
        recursive_count: 81,
        is_system: true,
        path: "D:/ComfyUI/output/krea2",
        children: [
          {
            id: 11,
            parent_id: 10,
            name: "subdir",
            order: 0,
            image_count: 81,
            recursive_count: 81,
            is_system: true,
            path: "D:/ComfyUI/output/krea2/subdir",
            children: [],
          },
        ],
      },
    ];
    const { system } = splitBySystem(tree);
    const all = flat(system);
    const totalImages = all.reduce((acc, n) => acc + n.recursive_count, 0);
    expect(totalImages).toBe(162);
    expect(all.find((n) => n.name === "krea2")?.recursive_count).toBe(81);
    expect(all.find((n) => n.name === "subdir")?.recursive_count).toBe(81);
  });
});

describe("FolderNode 类型字段", () => {
  it("可选 is_system / path 字段允许省略", () => {
    const node: FolderNode = {
      id: 1,
      parent_id: null,
      name: "x",
      order: 0,
      image_count: 0,
      recursive_count: 0,
      children: [],
    };
    expect(node.is_system).toBeUndefined();
    expect(node.path).toBeUndefined();
  });

  it("system folder 必须带 is_system=true 和 path", () => {
    const node: FolderNode = {
      id: 1,
      parent_id: null,
      name: "krea2",
      order: 0,
      image_count: 0,
      recursive_count: 81,
      is_system: true,
      path: "D:/ComfyUI/output/krea2",
      children: [],
    };
    expect(node.is_system).toBe(true);
    expect(node.path).toContain("krea2");
  });
});