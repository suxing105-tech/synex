import { describe, expect, it } from "vitest";
import {
  FOOTER_BITS_DIMS_MIN_WIDTH,
  basenameOnly,
  footerMetaBits,
  footerTimeLabel,
  parentFolderLabel,
  parentFolderPath,
} from "../lib/media-format";

/**
 * 卡片页脚显示什么（方案 3「生产力工作台」第二批）。
 * 第一行默认文件名（lib/card-title.ts 里可切成提示词开头那一句），第二行是所属文件夹徽标 + 元信息，
 * 这里钉住第二行的三条口径：按类型给字段、窄卡先撤尺寸、时间越近越具体。
 */

// 固定「现在」= 2026-11-11 15:00（本地时区），下面所有相对时间都对着它算
const NOW = new Date(2026, 10, 11, 15, 0, 0).getTime() / 1000;
const ago = (sec: number) => NOW - sec;

describe("第一行的退回值：带扩展名的文件名", () => {
  it("扩展名原样留着——用户要看得出这是 .png 还是 .psd", () => {
    expect(basenameOnly("original.jpg")).toBe("original.jpg");
    expect(basenameOnly("AnimateDiff_00001.png")).toBe("AnimateDiff_00001.png");
    expect(basenameOnly("vlog.final.cut.mp4")).toBe("vlog.final.cut.mp4");
    expect(basenameOnly("山雾.PNG")).toBe("山雾.PNG");
  });

  it("只取最后一段路径，反斜杠和正斜杠都算", () => {
    expect(basenameOnly("D:/a/b.png")).toBe("b.png");
    expect(basenameOnly("D:\\a\\b.png")).toBe("b.png");
    expect(basenameOnly("无目录.psd")).toBe("无目录.psd");
  });

  it("点号开头、没有扩展名、空串都不炸", () => {
    expect(basenameOnly(".gitignore")).toBe(".gitignore");
    expect(basenameOnly("README")).toBe("README");
    expect(basenameOnly("")).toBe("");
  });
});

describe("文件夹徽标：取素材所在文件夹的名字", () => {
  it("取倒数第二段——那是他自己组织素材的单位，不再是模型", () => {
    expect(parentFolderLabel("D:/AI/ComfyUI/output/krea2/AnimateDiff_00001.png")).toBe("krea2");
    expect(parentFolderLabel("D:/AI/ComfyUI/output/MiniMaxH3/自我介绍/影驰数字人_H3__00017-audio.mp4")).toBe("自我介绍");
    expect(parentFolderLabel("D:\\AI\\ComfyUI\\output\\video\\vlog_00001.mp4")).toBe("video");
  });

  it("正斜杠、反斜杠、混着写都算，中文目录名原样给", () => {
    expect(parentFolderLabel("D:/素材/旁白.mp3")).toBe("素材");
    expect(parentFolderLabel("D:/a\\b/旁白.mp3")).toBe("b");
    expect(parentFolderLabel("C:/素材/影驰5080HOF详情页/KV/KV_01.png")).toBe("KV");
  });

  it("没有上层文件夹就不给徽标，不摆个盘符或斜杠上去", () => {
    expect(parentFolderLabel("无目录.png")).toBeNull();
    expect(parentFolderLabel("")).toBeNull();
    expect(parentFolderLabel(null)).toBeNull();
    expect(parentFolderLabel(undefined)).toBeNull();
    expect(parentFolderLabel("/无上级.mp4")).toBeNull();
  });

  it("超长目录名截进徽标预算，不撑破页脚", () => {
    const long = parentFolderLabel("D:/素材/" + "超长文件夹名字".repeat(6) + "/x.png");
    expect((long ?? "").length).toBeLessThanOrEqual(25);
    expect((long ?? "").startsWith("超长文件夹名字")).toBe(true);
  });

  it("hover 用的 title 给整条上层目录，不是截断后的那截", () => {
    expect(parentFolderPath("D:/AI/ComfyUI/output/krea2/x.png")).toBe("D:/AI/ComfyUI/output/krea2");
    expect(parentFolderPath("D:\\AI\\krea2\\x.png")).toBe("D:\\AI\\krea2");
    expect(parentFolderPath("x.png")).toBe("");
  });
});

describe("时间：越近的事越具体，越久的事越短", () => {
  it("一小时内给分钟，一天内给小时", () => {
    expect(footerTimeLabel(ago(30), NOW)).toBe("刚刚");
    expect(footerTimeLabel(ago(5 * 60), NOW)).toBe("5 分前");
    expect(footerTimeLabel(ago(3 * 3600 + 40), NOW)).toBe("3 时前");
  });

  it("昨天只给两个字，今年给月日，跨年才补上年份", () => {
    expect(footerTimeLabel(ago(30 * 3600), NOW)).toBe("昨天");
    expect(footerTimeLabel(new Date(2026, 4, 9, 9, 0, 0).getTime() / 1000, NOW)).toBe("05/09");
    expect(footerTimeLabel(new Date(2025, 4, 9, 9, 0, 0).getTime() / 1000, NOW)).toBe("25/05/09");
  });

  it("缺时间戳就整段不给，不摆个空位", () => {
    expect(footerTimeLabel(0, NOW)).toBe("");
    expect(footerTimeLabel(null, NOW)).toBe("");
    expect(footerTimeLabel(Number.NaN, NOW)).toBe("");
  });

  it("未来的时间戳（机器时钟不准）说刚刚，不给出负数", () => {
    expect(footerTimeLabel(NOW + 3600, NOW)).toBe("刚刚");
  });
});

describe("元信息按类型给，窄卡先撤尺寸", () => {
  it("图片：宽卡给尺寸 + 时间，窄卡只剩时间", () => {
    const wide = footerMetaBits({
      kind: "image", width: 1920, height: 1080,
      path: "D:/AI/ComfyUI/output/krea2/AnimateDiff_00001.png", mtime: ago(600), now: NOW, columnWidth: 240,
    });
    expect(wide.folder).toBe("krea2");
    expect(wide.bits).toEqual(["1920×1080", "10 分前"]);
    const narrow = footerMetaBits({ kind: "image", width: 1920, height: 1080, mtime: ago(600), now: NOW, columnWidth: 202 });
    expect(narrow.bits).toEqual(["10 分前"]);
  });

  it("视频：时长一直都在（卡片上没有时长角标），尺寸跟宽卡一起回来", () => {
    expect(footerMetaBits({ kind: "video", width: 1280, height: 720, durationSeconds: 42, mtime: ago(3 * 3600), now: NOW, columnWidth: 240 }).bits)
      .toEqual(["0:42", "1280×720", "3 时前"]);
    expect(footerMetaBits({ kind: "video", width: 1280, height: 720, durationSeconds: 42, mtime: ago(3 * 3600), now: NOW, columnWidth: 180 }).bits)
      .toEqual(["0:42", "3 时前"]);
  });

  it("音频不再显示 840×360——那是波形画布的尺寸，不是素材的（这条是修 bug）", () => {
    const bits = footerMetaBits({ kind: "audio", width: 840, height: 360, durationSeconds: 95, mtime: ago(86400 * 3), now: NOW, columnWidth: 400 }).bits;
    expect(bits).toEqual(["1:35", "11/08"]);
    expect(bits.join("")).not.toContain("840");
  });

  it("缺哪个字段就整段省略，不留孤立的分隔符", () => {
    expect(footerMetaBits({ kind: "image", width: null, height: null, mtime: null, now: NOW }).bits).toEqual([]);
    expect(footerMetaBits({ kind: "image", width: 800, height: null, mtime: ago(600), now: NOW }).bits).toEqual(["10 分前"]);
    expect(footerMetaBits({ kind: "audio", width: null, height: null, durationSeconds: null, mtime: ago(600), now: NOW }).bits).toEqual(["10 分前"]);
  });

  it("尺寸露面的宽度门槛就是那个常量，不另写一个数", () => {
    const at = (w: number) => footerMetaBits({ kind: "image", width: 800, height: 600, mtime: ago(600), now: NOW, columnWidth: w }).bits;
    expect(at(FOOTER_BITS_DIMS_MIN_WIDTH)).toContain("800×600");
    expect(at(FOOTER_BITS_DIMS_MIN_WIDTH - 1)).not.toContain("800×600");
  });

  it("文件大小从卡片上撤了（扫描时没人靠字节数挑图，详情栏和灯箱都还在）", () => {
    const bits = footerMetaBits({ kind: "image", width: 800, height: 600, mtime: ago(600), now: NOW, columnWidth: 400 }).bits;
    expect(bits.join(" ")).not.toMatch(/B\b/);
  });
});
