# -*- coding: utf-8 -*-
"""修素材选择器的搜索框：换族那条 effect 里顺手调 load()，把 query 变成了自己的依赖，
于是「打字」= 「换了一批素材」= 重读列表并清空关键词。用 untrack 把副作用段摘出依赖。"""
import io

P = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/src/components/MediaPickerModal.svelte"

OLD_IMP = '''  import { get } from "svelte/store";'''
NEW_IMP = '''  import { untrack } from "svelte";
  import { get } from "svelte/store";'''

OLD_EFF = '''  $effect(() => {
    if (!open) return;
    // 换一族＝换一批素材：换目标格（prop kind 变）或在顶部 tab 之间切换，列表都得跟着重读。
    void activeKind;
    query = "";
    hoveredId = null;
    stopPreviewAudio();
    void load();
  });'''
NEW_EFF = '''  /**
   * 换一族＝换一批素材：换目标格（prop kind 变）或在顶部 tab 之间切换，列表都得跟着重读。
   *
   * 这一族只准认 open 与 activeKind，其余副作用必须整段 untrack。
   * load() 会读 query（拼进 q=），loaded 也在它里面读；不 untrack 的话这些读全部算作本
   * effect 的依赖 ⇒ 在搜索框里敲一个字就等价于「换了一批素材」⇒ effect 重跑 ⇒ 把刚敲进去
   * 的关键词抹成空串再重读一遍全量。用户看到的症状是搜索框不能搜索：字打不进去，
   * 点「搜索」永远发的是空查询。试听那条同理（stopPreviewAudio 读了 playingAudio store），
   * 否则放一段音频也会顺手清空搜索框。
   */
  $effect(() => {
    if (!open) return;
    void activeKind;
    untrack(() => {
      query = "";
      hoveredId = null;
      stopPreviewAudio();
      void load();
    });
  });'''

t = io.open(P, encoding="utf-8", newline="").read()
for old, new in ((OLD_IMP, NEW_IMP), (OLD_EFF, NEW_EFF)):
    assert t.count(old) == 1, ("anchor not unique: " + old[:40] + " -> " + str(t.count(old)))
    t = t.replace(old, new)
io.open(P, "w", encoding="utf-8", newline="").write(t)
print("patched", P)
