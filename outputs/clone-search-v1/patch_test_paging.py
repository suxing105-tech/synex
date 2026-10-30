# -*- coding: utf-8 -*-
"""翻页那条用例的 fixture 修正：第二页必须给不同的 id，否则 keyed each 直接判重复键，
测的就不是「翻页还带着查询」了。"""
import io

P = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/src/__tests__/media-picker.test.ts"

OLD = '''  it("搜完翻页还在同一批结果里：加载更多不许把查询丢了", async () => {
    (imagesApi.list as ReturnType<typeof vi.fn>).mockResolvedValue({ items: ITEMS, total: 9 });'''
NEW = '''  it("搜完翻页还在同一批结果里：加载更多不许把查询丢了", async () => {
    // 第二页必须换一批 id：keyed each 拿到重复 id 会先炸在 each_key_duplicate 上，测不到正题。
    const page2 = [{ id: 11, filename: "p11.png", path: "D:/p11.png", kind: "image", width: 768, height: 1360, original_url: "/api/images/11/file", thumbnail_url: "/api/images/11/file" }];
    (imagesApi.list as ReturnType<typeof vi.fn>).mockImplementation(async (arg: any) =>
      arg.offset ? { items: page2, total: 9 } : { items: ITEMS, total: 9 });'''

t = io.open(P, encoding="utf-8", newline="").read()
assert t.count(OLD) == 1, "anchor not unique: " + str(t.count(OLD))
t = t.replace(OLD, NEW)
io.open(P, "w", encoding="utf-8", newline="").write(t)
print("patched tests")
