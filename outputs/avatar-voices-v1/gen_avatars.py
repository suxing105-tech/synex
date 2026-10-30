# -*- coding: utf-8 -*-
"""按「音色性格」重做 9 张音色头像。

为什么要重建工作流：原九张 PNG 里嵌的 API prompt 用了 LoraManager 的 LORAS 自定义输入，
直接回贴给 /prompt 会被判 bad_linked_input，整条采样链被丢弃（只跑出 showAnything）。
这里按当次真正生效的 6 个 LoRA（active=true）+ 同一套模型/采样器重建成干净的标准图。

另一个原图的问题顺手记一下：原 prompt 把「负面：…写实照片质感…」拼进了正向条件
（真正的负面被 ConditioningZeroOut 清零），所以「扁平矢量」根本不可能生效。
本版提示词只写正向描述，不再放负面清单。

用法：
    python gen_avatars.py                      # 九张全跑
    python gen_avatars.py Vivian Serena        # 只跑指定几个
    python gen_avatars.py Vivian --seed 1000 --tag roll2
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

COMFY = "http://127.0.0.1:8188"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
CAND_DIR = os.path.join(OUT_DIR, "candidates")
PREFIX = "seekx_av"

UNET = "Krea2\\krea2_turbo_bf16.safetensors"
CLIP = "Qwen\\qwen3vl_4b_fp8_scaled.safetensors"
VAE = "Qwen\\qwen_image_vae.safetensors"
# 原图 active=true 的 LoRA，顺序照 351 → 354
LORAS = [
    ("Krea2\\krea2-Cc-Ins风-人像.safetensors", 0.90),
    ("Krea2\\krea2-Cc-MJ-风格滤镜.safetensors", 1.00),
    ("Krea2\\滑块\\Realism\u00a0真实感.safetensors", 0.85),
    ("Krea2\\滑块\\Amateur业余拍摄.safetensors", -2.00),
    ("Krea2\\滑块\\Detailer-KREA2.safetensors", 0.80),
    ("Krea2\\滑块\\zoom变焦.safetensors", 1.00),
]
SIDE = 1416          # 原图 ResolutionSelector 1:1 @2.0MP
HIRES = 1.5

BASE = (
    "电影级写实人像特写，高级人像摄影与CG厚涂之间的质感，浅景深，柔和侧顺光加清晰的边缘轮廓光，"
    "深炭灰纯色背景接近 #2A2A2E，人物背后一层极淡的强调色径向光晕，头肩四分之三近景，人物居中，"
    "面部与主体受光充足、整张脸清楚可读、不要把半边脸埋进死黑，头顶留出约十分之一的空白，肩部可以出血，"
    "圆形头像裁切安全区，正方形 1:1 构图，单一强调色配色，哑光质感，皮肤与发丝细节清晰，"
    "画面干净清爽，只有一个人物。整张脸的亮度要足够在 48 像素的圆形小图里一眼看清五官，明暗过渡柔和、画面里不出现大面积死黑，人物边缘与背景之间有清楚的亮度差。"
)

# 性格方向照 Qwen3-TTS 官方 speaker 描述，语义锚点（火花/王冠/樱花等）保留。
PERSONAS = {
    "Vivian": "一位二十多岁的中国年轻女性，齐肩短发蓬松微卷、发尾被动感向上扬起，一侧头发别在耳后，耳垂一枚小小的黄色圆环耳饰；她咧嘴大笑露出牙齿，眉毛轻轻挑起，眼睛弯成明亮的弧线却直直看向镜头，笑意里带一点不好惹的锋利与痞气；明黄色高领毛衣外搭黑色外套，一颗黄色四角小火花浮在她耳侧上方，背景从中心向外扩散的明黄色柔光，整张脸明亮、有速度感。强调色明黄 #F5C842。",
    "Serena": "一位二十多岁的中国年轻女性，中分顺直长发垂过肩，几缕发丝被光照亮；她嘴角带一点温暖的闭口笑，眼神柔和地看向镜头，头轻轻偏向一侧，神情松弛、亲和、安定；青蓝色柔软针织高领衫，暖金色侧顺光照亮脸颊与鼻梁，冷色衣物与暖色肤色形成温柔对比，身后一圈极淡的同心水波纹与薄雾感，脸颊与鼻梁受光充分、肤色暖润，画面干净通透，像被阳光晒暖的湖面。强调色青蓝 #4FA8C7，光为暖金。",
    "Uncle_Fu": "一位六十岁上下的中国长者，花白短寸发与花白山羊短须，圆润的金属细框眼镜，眼角笑纹深刻，脸颊饱满，笑得和蔼从容，气质像一位说话低沉温和的老师父；深赭色立领中式布扣上衣，肩侧一小枝简化的绿色竹叶，暖琥珀色侧光照亮半边脸、另一侧保留柔和而不死黑的暗部。强调色暖琥珀 #C8803A。",
    "Dylan": "一位二十岁出头的中国年轻男性，被风吹乱的中等长度微卷发，几缕发丝横过额头，下巴有薄薄胡茬，眼睛清亮有神，自然露齿地笑，神情清爽利落、像说话干净爽利的北京小伙子，整张脸受光均匀明亮；海蓝绿连帽外套领子立起，身后两道简洁的海浪弧线与几颗上浮的水珠，冷调蓝绿光线，画面带一点风的感觉。强调色海蓝绿 #2F8F86。",
    "Eric": "一位三十岁出头的中国男性，短而硬的头发剃出利落鬓角，脸刮得干干净净、一根胡子都没有，皮肤紧致、面色红润透亮；他咧开嘴笑出声，露出一排牙齿，眼角笑纹堆起来，眉毛一挑，眼神机灵热络，像成都茶馆里最会讲段子的那一位，热闹、亲切、带点痞气，绝不冷峻；钢青色棒球夹克领子立起、里面一件浅色T恤，背景是几道干净的斜向几何光带，冷钢青环境光配明亮的暖色主光把整张脸照亮，硬朗里全是幽默感。强调色钢青 #5B7FA6。",
    "Ryan": "一位二十多岁的欧美年轻男性，蓬松微乱的短发，正面朝向镜头、头略微前倾，肩颈带张力；他开口大笑像说到一半，眼睛明亮有神，神情自信俏皮，整个人充满节奏感与舞台能量，像随时会动起来；皇家紫连帽卫衣，头顶浮着一顶只勾轮廓的三尖小王冠、王冠上一点金色高光，背景紫色到深紫的动感光带与轻微速度拖影，光线明快、对比强。强调色皇家紫 #8A6FD1。",
    "Aiden": "一位二十多岁的欧美年轻男性，暖棕色蓬松短发向上梳起、发梢染成琥珀橙，正脸微侧，笑得爽朗露齿，眼睛明亮温暖，气质是阳光坦率的大男孩而不是阴郁；深炭色圆领上衣，脸颊两侧三四点细小的橙色火星向上浮起，背景自下而上的橙金暖光像清晨的火焰，整张脸被暖光充分照亮、通透不发暗。强调色琥珀橙 #EF8A2C。",
    "Ono_Anna": "一位二十岁出头的日本年轻女性，黑色长直发配齐刘海、松松的低马尾，头轻轻歪向一侧；她抿嘴忍笑、一侧嘴角上扬，眼睛亮而灵动地斜看镜头，神情俏皮轻盈、带一点小狡黠；墨黑色简洁高领上衣，一枝淡樱花斜放在她肩前，几片樱花瓣在空中飘起，背景大面积深炭灰留白、只有一小片淡樱粉色，光线清透、画面有呼吸感。强调色淡樱 #EBB7C4。",
    "Sohee": "一位二十多岁的韩国年轻女性，深棕黑色的柔顺长发（不要彩色头发），四分之三侧脸朝向斜上方的光，眼睛轻抬望向光源，眼神含着情绪、嘴角有温柔的笑意；淡银紫柔软针织衣物，发丝边缘被逆光照亮形成一圈细碎的发光轮廓，肩后一圈大而柔的光晕与两三粒细小光点，冷白偏紫的通透光感、肤色与脸部保持温暖明亮、不要整张脸发灰。强调色月银紫 #C9C3E8。",
}
SEEDS = {"Vivian": 20261030, "Serena": 20261031, "Uncle_Fu": 20261032, "Dylan": 20261033,
         "Eric": 20261034, "Ryan": 20261035, "Aiden": 20261036, "Ono_Anna": 20261037, "Sohee": 20261038}


def http(url, data=None):
    if isinstance(data, (dict, list)):
        data = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def graph_for(slug, tag, seed):
    text = BASE + " " + PERSONAS[slug]
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "krea2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "20": {"class_type": "CLIPTextEncode", "inputs": {"text": text, "clip": ["19", 1]}},
        "21": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["20", 0]}},
        "30": {"class_type": "EmptySD3LatentImage", "inputs": {"width": SIDE, "height": SIDE, "batch_size": 1}},
        "40": {"class_type": "KSamplerAdvanced", "inputs": {"add_noise": "enable", "noise_seed": seed, "steps": 8,
               "cfg": 1.0, "sampler_name": "er_sde", "scheduler": "simple", "start_at_step": 0, "end_at_step": 8,
               "return_with_leftover_noise": "disable", "model": ["19", 0], "positive": ["20", 0],
               "negative": ["21", 0], "latent_image": ["30", 0]}},
        "41": {"class_type": "LatentUpscaleBy", "inputs": {"upscale_method": "bicubic", "scale_by": HIRES, "samples": ["40", 0]}},
        "42": {"class_type": "KSamplerAdvanced", "inputs": {"add_noise": "enable", "noise_seed": seed, "steps": 8,
               "cfg": 1.0, "sampler_name": "er_sde", "scheduler": "simple", "start_at_step": 5, "end_at_step": 10000,
               "return_with_leftover_noise": "disable", "model": ["19", 0], "positive": ["20", 0],
               "negative": ["21", 0], "latent_image": ["41", 0]}},
        "43": {"class_type": "VAEDecode", "inputs": {"samples": ["42", 0], "vae": ["3", 0]}},
        "44": {"class_type": "SaveImage", "inputs": {"images": ["43", 0], "filename_prefix": "%s/%s_%s" % (PREFIX, slug, tag)}},
    }
    prev_m, prev_c, prev_c_slot = "1", "2", 0
    for idx, (name, strength) in enumerate(LORAS):
        nid = str(10 + idx)
        g[nid] = {"class_type": "LoraLoader", "inputs": {"model": [prev_m, 0], "clip": [prev_c, prev_c_slot],
                  "lora_name": name, "strength_model": strength, "strength_clip": strength}}
        prev_m, prev_c, prev_c_slot = nid, nid, 1
    g["20"]["inputs"]["clip"] = [prev_c, prev_c_slot]
    g["40"]["inputs"]["model"] = [prev_m, 0]
    g["42"]["inputs"]["model"] = [prev_m, 0]
    return g


def submit(g):
    return http(COMFY + "/prompt", {"prompt": g, "client_id": uuid.uuid4().hex})


def wait(pid, timeout=1200):
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        hist = http(COMFY + "/history/" + pid)
        if pid in hist:
            entry = hist[pid]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError("ComfyUI 执行报错：" + json.dumps(status.get("messages", []), ensure_ascii=False)[:1500])
            if entry.get("outputs", {}).get("44"):
                return entry
    raise TimeoutError("等待超时：" + pid)


def fetch(entry, slug, tag):
    os.makedirs(CAND_DIR, exist_ok=True)
    got = []
    for img in entry["outputs"]["44"].get("images", []):
        q = urllib.parse.urlencode({"filename": img["filename"], "subfolder": img.get("subfolder", ""), "type": img["type"]})
        local = os.path.join(CAND_DIR, "%s_%s.png" % (slug, img["filename"].replace("/", "_")))
        with urllib.request.urlopen(COMFY + "/view?" + q, timeout=180) as r, open(local, "wb") as f:
            f.write(r.read())
        got.append(local)
    return got


def main():
    args = list(sys.argv[1:])
    tag, seed_shift, todo = "roll1", 0, []
    while args:
        a = args.pop(0)
        if a == "--tag":
            tag = args.pop(0)
        elif a == "--seed":
            seed_shift = int(args.pop(0))
        else:
            todo.append(a)
    todo = todo or list(PERSONAS)
    for slug in todo:
        if slug not in PERSONAS:
            print("[skip] 不认识的名字", slug, flush=True)
            continue
        seed = SEEDS[slug] + seed_shift
        t0 = time.time()
        resp = submit(graph_for(slug, tag, seed))
        pid = resp["prompt_id"]
        if resp.get("node_errors"):
            print("[reject]", slug, json.dumps(resp["node_errors"], ensure_ascii=False)[:800], flush=True)
            continue
        files = fetch(wait(pid), slug, tag)
        print("[ok] %s seed=%s %.0fs -> %s" % (slug, seed, time.time() - t0, ", ".join(os.path.basename(f) for f in files)), flush=True)


if __name__ == "__main__":
    main()
