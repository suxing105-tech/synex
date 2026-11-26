"""随包那条「闪寻扩图」：外补画板那套约定是不是真的随包带着走。

扩图和其它两条图片工作流差在一件事上——往四边各补多少画面，不是在右下角那颗参数弹层里
敲数字，而是在画面上把边框拖出来。所以这里守的是两头的接缝：

- 正文里 48 号画板必须回到出厂（四边 0、比例自由、pads 缓存清空）。那份
  `gh_visual_layout` 是 ComfyUI 前端替上一次拖动缓存的**像素** pads，签名一核对得上节点
  就直接照它出图——带着别人机器上的一次拖动进安装包，等于每个人装上就多一个看不见的默认构图。
- 槽位得带着「这六颗画进画板」这个说法活着过一遍 normalize_slots。前端只认这个键，
  丢了它扩图就退化成四格谁也读不出方向的数字框。

只碰随包资源与本地 SQLite，绝不连真机 ComfyUI。
"""
from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from app import clone_bundled, clone_templates
from app.clone_templates import (
    BOARD_INPUTS, build_workflow, normalize_slots, parse_workflow, slot_key,
)

OUTPAINT_KEY = "qwen-single-image-outpaint"
# 画板上那六颗：四边 + 按什么单位记 + 凑哪个比例。少一颗画板就有一件事做不到。
BOARD_KEYS = ["48.左", "48.右", "48.上", "48.下", "48.单位", "48.gh_visual_ratio"]
# 外补画板那台节点自己给的 12 档，连顺序一起照它（画板上那一排档位就是这一列）
RATIOS = ["自由比例", "1:1", "2:3", "3:2", "3:4", "4:3", "5:7", "9:16", "16:9", "21:9", "1:2", "2:1"]
# 画板补出来的那片灰：那句写死的主指令叫模型「移除灰色区域」，两处必须是同一个灰
OUTPAINT_TINT = "#808080"
# 成图最长边封顶：节点量程到 8192，随包这一版收在 5120（再大显存吃不住，也不会有人要）
MAX_OUTPUT_EDGE = 5120


@pytest.fixture
def entry():
    return [e for e in clone_bundled.entries() if e["key"] == OUTPAINT_KEY][0]


@pytest.fixture
def seeded(tmp_path: Path, monkeypatch):
    """开内置开关 + 空库：走的就是「新装用户第一次打开」那条路。"""
    monkeypatch.setenv("SUXING_GALLERY_DATA_DIR", str(tmp_path))
    from app import config, db

    importlib.reload(config)
    importlib.reload(db)
    monkeypatch.setenv("SUXING_SEED_BUNDLED_TEMPLATES", "1")
    pool = db.init_pool()
    pool.initialize()
    return pool


# ---------- 随包正文 ----------

def test_the_board_boots_at_zero(entry):
    """48 号画板随包必须是出厂那一份：四边 0、比例自由、拖动缓存清空。

    四边默认 0 是苏醒定的（2026-11 讨论：给一个默认外补等于替每个人决定构图，
    而 0 会在点生成之前先拦一道，说清「四个方向都还是 0」）。
    `gh_visual_layout` 那一份尤其必须空：它是缓存的像素 pads，签名 = [宽, 高, 单位, 四边]，
    随包那份的签名正好和出厂值对得上，节点会照着它出图，出厂四边就白设了。
    """
    board = entry["workflow"]["48"]["inputs"]
    assert [board["左"], board["右"], board["上"], board["下"]] == [0, 0, 0, 0]
    assert board["单位"] == "百分比" and board["gh_visual_ratio"] == "自由比例"
    assert board["gh_visual_layout"] == "", "拖动缓存不许跟着安装包走"
    assert board["最大输出长边"] == MAX_OUTPUT_EDGE
    # 整除数 0 = 出图尺寸就是画板算出来的那个数。随这一版的画板只锁最长边，不锁对齐倍数，
    # 前端报「将生成多大」时才不必再复算一遍取整（节点源码里那一段整除数分支会整个跳过）。
    assert board["整除数"] == 0
    assert board["外补颜色"].lower() == OUTPAINT_TINT


def test_the_gray_the_prompt_names_is_the_gray_the_board_paints(entry):
    """主指令说的颜色必须就是画板补出来的那片颜色。

    扩图这条没有 MASK 直接进模型：48 号把外补区域涂成 `外补颜色`，写死的那句
    （33 号）叫模型「移除图像中的灰色区域，无缝自然延展」。哪天要换那片颜色，
    画板、缩放节点的填充色和那句话得一起改——只改一处，模型就找不到该延展的地方。
    缩放那次（5 号）也要同一个灰：长边超过最大采样尺寸时它也会补色。
    """
    line = str(entry["workflow"]["33"]["inputs"]["value"])
    assert "灰色" in line, line
    assert entry["workflow"]["48"]["inputs"]["外补颜色"].lower() == OUTPAINT_TINT
    assert entry["workflow"]["5"]["inputs"]["填充颜色"].lower() == OUTPAINT_TINT


def test_the_preview_comparer_is_out_and_the_prefix_is_ours(entry):
    """纯预览的比对器摘掉，存图前缀换成随包自己的，且输出节点只剩一个。

    rgthree 那台 Image Comparer 只是给人看的一块对比面板，留着它却让所有没装
    rgthree 的人这份工作流直接加载失败。ComfyUI 会执行图里每一个输出节点，
    多一个输出就是每次多等一截，所以到 SaveImage 之外不许再有第二个。
    """
    nodes = clone_bundled._prepare(entry)[0]
    assert "23" not in nodes
    assert not [nid for nid, node in nodes.items()
                if "rgthree" in str(node.get("class_type", "")).lower()]
    assert nodes["46"]["inputs"]["filename_prefix"] == "SeekX_Outpaint"
    outs = [nid for nid, node in nodes.items()
            if str(node.get("class_type", "")).lower().startswith(("save", "preview"))]
    assert outs == ["46"]


# ---------- 槽位约定 ----------

def test_the_board_slots_survive_the_slot_contract(entry):
    """六颗画板控件都得带着 ui="board" 活着过一遍 normalize_slots。

    这个键是前端唯一的依据：认了才把四边/单位/比例搬到画面上那层画板里，
    不认就退回右下角那颗参数弹层的四格数字框——四格数字框读不出「往哪儿扩」，
    等于把扩图做成了让人猜的四个数字。
    """
    nodes, slots = clone_bundled._prepare(entry)
    by_key = {slot_key(s): s for s in slots}
    assert sorted(by_key) == sorted(BOARD_KEYS + ["51.value", "1.image", "27.值"])
    for key in BOARD_KEYS:
        assert by_key[key]["ui"] == "board", key
    for key in ("51.value", "1.image", "27.值"):
        assert "ui" not in by_key[key], key
    # 画板那六颗确实都在同一台节点上：画板一次要读六个值，分两台就没法一次画完
    assert {by_key[k]["node"] for k in BOARD_KEYS} == {"48"}
    for key in ("48.左", "48.右", "48.上", "48.下"):
        # 上限 3000 是节点自己的量程。像素模式下它是「往外扩 3000 个像素」，
        # 收成百分比那种小数字会让像素模式拖不动。
        assert (by_key[key]["min"], by_key[key]["max"], by_key[key]["value"]) == (0, 3000, 0), key
        assert by_key[key]["step"] == 1, key


def test_a_board_slot_that_cannot_find_its_six_inputs_is_refused(entry):
    """点名要画进画板、可那台节点凑不齐六颗，就当场吵，不许装成一条画不动的模板。

    少任何一颗都不是「少一个功能」而是画板直接画不出来：缺单位就不知道该按百分比
    还是按像素算四边，缺比例就凑不出目标画幅，缺任意一边则那条边界拖不动。
    """
    nodes = parse_workflow(entry["workflow"])
    del nodes["48"]["inputs"]["下"]
    board_slot = {"kind": "number", "node": "48", "input": "左", "label": "向左扩",
                  "min": 0, "max": 3000, "ui": "board"}
    with pytest.raises(ValueError) as refused:
        normalize_slots([board_slot], nodes)
    assert "下" in str(refused.value)
    assert "画板" in str(refused.value)
    # 同一条槽位不点名画板就照常装：这道闸只管画板那种画法，别的工作流的数字框不受牵连
    plain = {k: v for k, v in board_slot.items() if k != "ui"}
    prompt = {"kind": "prompt", "node": "51", "input": "value", "label": "补充提示词"}
    assert [s["input"] for s in normalize_slots([plain, prompt], nodes)] == ["左", "value"]
    # 名单本身也钉一条：六颗是按名字写死的，改了名字却没改名单，闸就形同虚设
    assert list(BOARD_INPUTS) == ["左", "右", "上", "下", "单位", "gh_visual_ratio"]


def test_the_board_slots_never_touch_the_layout_cache(entry):
    """提交时只写那六颗旋钮，`gh_visual_layout` 一个字都不写，永远留空。

    缓存里那份是**像素** pads，而弹窗里的四边可以按百分比记：写了就得在前端替节点
    复算一遍百分比，复算与节点那一句 `int(v * 边长 / 100)` 差一个取整方向，
    屏幕上的画板和真出来的图就差几像素。留空 = 节点自己按它那份源码算，只有一份账。
    """
    nodes, slots = clone_bundled._prepare(entry)
    workflow, _ = build_workflow(
        nodes, slots, prompt="把背景延成傍晚的云", references={"1.image": "a.png"},
        controls={"48.左": 30, "48.右": 0, "48.上": 12, "48.下": 0,
                  "48.单位": "像素", "48.gh_visual_ratio": "9:16", "27.值": 1536},
    )
    board = workflow["48"]["inputs"]
    assert (board["左"], board["右"], board["上"], board["下"]) == (30, 0, 12, 0)
    assert (board["单位"], board["gh_visual_ratio"]) == ("像素", "9:16")
    assert board["gh_visual_layout"] == ""
    # 出厂正文一个字不改：build_workflow 拿的是副本
    assert entry["workflow"]["48"]["inputs"]["左"] == 0
    assert workflow["1"]["inputs"]["image"] == "a.png"
    assert workflow["51"]["inputs"]["value"] == "把背景延成傍晚的云"
    assert workflow["27"]["inputs"]["值"] == 1536


def test_the_outpaint_prompt_is_only_a_supplement(entry):
    """提示词留空是一个正经模式：主指令写死在正文里，这一格只写额外要求。

    没有 allow_empty 时后端会按「必须填提示词」把空框顶回去，用户对着一个
    「其实什么都不用写」的框干瞪眼；empty_hint 是这句说法的出处，
    前端不许自己编（它不知道那句写死的主指令是什么）。
    """
    nodes, slots = clone_bundled._prepare(entry)
    prompts = [s for s in slots if s.get("kind") == "prompt"]
    assert [s["label"] for s in prompts] == ["补充提示词"], "别叫「完整提示词」：这句不是主指令"
    assert prompts[0]["allow_empty"] is True
    assert "留空" in prompts[0]["empty_hint"]
    # 主指令在正文里，不是一条槽位：摆在弹窗里就是一格没人会动、动错一个字扩图当场失灵的框
    assert entry["workflow"]["33"]["class_type"] == "easy string"
    assert "33.value" not in {slot_key(s) for s in slots}


def test_the_ratio_options_are_the_nodes_twelve(entry):
    """画板上那一排比例档位就是那台节点给的 12 档，连顺序一起。

    多一档少一档，前端配的画幅和节点自己配的就不是一回事；顺序也跟节点走，
    同一份工作流在 ComfyUI 里打开时下拉里是同一个列法。
    """
    nodes, slots = clone_bundled._prepare(entry)
    by_key = {slot_key(s): s for s in slots}
    assert by_key["48.gh_visual_ratio"]["options"] == RATIOS
    assert by_key["48.gh_visual_ratio"]["value"] == "自由比例"
    assert by_key["48.单位"]["options"] == ["百分比", "像素"]
    assert by_key["48.单位"]["value"] == "百分比"


def test_the_sampling_size_ships_as_a_slider(entry):
    """最大采样尺寸是滑块，默认 2048，量程 1024–3840，步长 128。

    这颗管的是「送进模型重画那一遍用多大」，不是成图尺寸（成图尺寸归画板）：
    5 号缩放节点按 `min(max(1024, 画板长边), 这一颗)` 缩，再对齐到 32。
    所以默认给 2048 而不是 3840——扩图补出来的那片本来就该以原图分辨率贴回去，
    采样尺寸只是决定那一片重画得够不够细。
    """
    authored = next(s for s in entry["slots"] if s.get("label") == "最大采样尺寸")
    assert authored["slider"] is True
    assert (authored["min"], authored["max"], authored["step"], authored["value"]) == (
        1024, 3840, 128, 2048)
    nodes = clone_bundled._prepare(entry)[0]
    assert nodes["27"]["inputs"]["值"] == authored["value"], "正文与槽位对不上时弹窗报的数和跑的不是一个"


# ---------- 装进库 ----------

def test_the_outpaint_template_is_seeded_but_never_the_default(seeded):
    """新装库三条图片工作流都在，「当前」仍是闪寻图片生成。

    随包装载按 key 排序插入，谁排在一个族的第一条就成了那个族的「当前」。
    `qwen-single-image-outpaint` 故意排在 `qwen-multi-image-edit` 之后：
    把名字改成排在它前面（例如 qwen-image-outpaint）就会悄悄换掉新装用户默认那条，
    而这条测试正是那笔改名的刹车。老库（已经有当前）走的是另一条路，不受影响。
    """
    rows = [r for r in clone_templates.list_templates() if r["media_kind"] == "image"]
    assert {r["bundled_key"] for r in rows} == {
        "qwen-multi-image-edit", "qwen-single-mask-edit", OUTPAINT_KEY}
    assert [r["name"] for r in rows if r["is_active"]] == ["闪寻图片生成"]
    board = [r for r in rows if r["bundled_key"] == OUTPAINT_KEY][0]
    assert board["is_active"] == 0
    assert [slot_key(s) for s in board["slots"] if s.get("ui") == "board"] == BOARD_KEYS


def test_seeding_reaches_the_stored_board_slots(seeded):
    """存进库的那一份也带着 ui="board"：前端读的是库，不是随包 JSON。

    这条和 `test_the_board_slots_survive_the_slot_contract` 各守一头——随包文件写对了、
    normalize 之后丢了，界面上照样看不见画板。
    """
    row = seeded.main().execute(
        "SELECT slots, workflow FROM clone_templates WHERE bundled_key=?",
        (OUTPAINT_KEY,),
    ).fetchone()
    slots = json.loads(str(row["slots"]))
    assert [slot_key(s) for s in slots if s.get("ui") == "board"] == BOARD_KEYS
    stored = json.loads(str(row["workflow"]))
    assert stored["48"]["inputs"]["gh_visual_layout"] == ""
    assert [stored["48"]["inputs"][k] for k in ("左", "右", "上", "下")] == [0, 0, 0, 0]


def test_the_board_is_the_only_extra_ui_the_outpaint_template_asks_for(seeded):
    """扩图只在画板上多一层，别的工作流不许被顺手带上：认画板的键只有 ui="board"。

    和「只有局部编辑那条认遮罩」是同一条尺（见 test_the_mask_template_is_the_only_one_with_a_brush）：
    画板要有六颗点名过的输入才画得出来，别的模板上它是一块空白板。
    """
    for row in clone_templates.list_templates():
        tagged = [slot_key(s) for s in row["slots"] if s.get("ui") == "board"]
        assert tagged == (BOARD_KEYS if row["bundled_key"] == OUTPAINT_KEY else []), row["name"]
