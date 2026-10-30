# -*- coding: utf-8 -*-
"""补测试：音色头像的映射、静态资源存在、弹窗里真的画出九张脸。"""
import io

ROOT = r"C:/Users/Administrator/Documents/ChatGPT/苏醒图库/frontend/src"

LIB = ROOT + "/__tests__/clone-lib.test.ts"
LIB_IMPORT_OLD = "  workflowMenuRows, workflowDisplayName, AUDIO_MODE_GROUP_LABEL,"
LIB_IMPORT_NEW = "  workflowMenuRows, workflowDisplayName, AUDIO_MODE_GROUP_LABEL, voiceAvatar,"
LIB_ANCHOR = """    expect(optionLabel("zh")).toBe("中文");
  });
});
"""
LIB_ADD = LIB_ANCHOR + '''
describe("内置音色的头像：认得出是谁才给脸", () => {
  // 键 = 官方 speaker 选项值。图放在 public/voices/ 走静态托管，路径就是文件名。
  const NINE: [string, string][] = [
    ["Vivian", "/voices/vivian.webp"],
    ["Serena", "/voices/serena.webp"],
    ["Uncle_Fu", "/voices/uncle-fu.webp"],
    ["Dylan", "/voices/dylan.webp"],
    ["Eric", "/voices/eric.webp"],
    ["Ryan", "/voices/ryan.webp"],
    ["Aiden", "/voices/aiden.webp"],
    ["Ono_Anna", "/voices/ono-anna.webp"],
    ["Sohee", "/voices/sohee.webp"],
  ];

  it("Qwen3-TTS 那九个内置音色各对一张脸，下划线和括号后缀都不影响", () => {
    for (const [option, path] of NINE) {
      expect(voiceAvatar(option), option).toBe(path);
    }
    // 后端把选项写成带说明的样式时也要认得（optionLabel 先把括号切掉）
    expect(voiceAvatar("Ono_Anna（日语）")).toBe("/voices/ono-anna.webp");
    expect(voiceAvatar(" uncle_fu ")).toBe("/voices/uncle-fu.webp");
  });

  it("认不出的选项一律没有脸：语种、比例、用户自己练的音色都不许乱配", () => {
    for (const option of ["Auto", "Chinese", "中文", "9:16", "my_voice", "Vivi", "", "   "]) {
      expect(voiceAvatar(option), option).toBeNull();
    }
  });

  it("九张头像文件真的在 public/voices/ 下，且是 WebP", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    for (const [, urlPath] of NINE) {
      const p = path.resolve(__dirname, "..", "..", "public", urlPath.replace(/^\\//, ""));
      expect(fs.existsSync(p), `${urlPath} 应在 public/ 下`).toBe(true);
      const buf = fs.readFileSync(p);
      // RIFF....WEBP
      expect(buf.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(buf.subarray(8, 12).toString("latin1")).toBe("WEBP");
      expect(buf.length).toBeGreaterThan(2000);
    }
  });
});
'''

MODAL = ROOT + "/__tests__/clone-modal.test.ts"
MODAL_ADD = """
const A_CUSTOM9 = audioTpl({
  id: 14, name: '闪寻指定音色',
  slots: [
    { kind: 'prompt', node: '37', input: 'text', label: '完整提示词' },
    { kind: 'select', node: '37', input: 'speaker', label: '音色',
      options: ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'], value: 'Vivian' },
    { kind: 'select', node: '37', input: 'language', label: '语言', options: ['Auto', 'Chinese'], value: 'Auto' },
  ],
  reference_cells: [],
});

it('指定音色那一格是九张脸：认得出的选项摆头像，语言格照旧是小圆点', async () => {
  routes({ ...baseRoutes(), '/api/clone/templates': { items: [A_CUSTOM9] } });
  const screen = await ready({ image: AUDIO_CARD });
  // 选中谁，底部那颗胶囊就带上谁的脸——不用点开面板也知道现在用的是哪个音色
  const pillFace = screen.querySelector('.cm-pill-face') as HTMLImageElement | null;
  expect(pillFace?.getAttribute('src')).toBe('/voices/vivian.webp');
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  const grids = [...pop.querySelectorAll('.cm-ratio-grid')];
  const faces = [...grids[0].querySelectorAll('img.cm-ratio-face')];
  expect(faces.map((img) => img.getAttribute('src'))).toEqual([
    '/voices/vivian.webp', '/voices/serena.webp', '/voices/uncle-fu.webp',
    '/voices/dylan.webp', '/voices/eric.webp', '/voices/ryan.webp',
    '/voices/aiden.webp', '/voices/ono-anna.webp', '/voices/sohee.webp',
  ]);
  // 脸是装饰，名字才是可读的那一份：alt 必须空，字必须还在
  expect(faces.every((img) => img.getAttribute('alt') === '')).toBe(true);
  expect([...grids[0].querySelectorAll('.cm-ratio-label')].map((el) => el.textContent)).toEqual([
    'Vivian', 'Serena', 'Uncle Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono Anna', 'Sohee',
  ]);
  // 语种那一格没有脸，仍然走那颗小圆点
  expect(grids[1].querySelectorAll('img.cm-ratio-face').length).toBe(0);
  expect(grids[1].querySelectorAll('.cm-ratio-flat').length).toBe(2);
  // 点到第三个人：胶囊上的脸跟着换
  await fireEvent.click(screen.getByRole('button', { name: 'Uncle_Fu' }));
  await tick();
  expect((screen.querySelector('.cm-pill-face') as HTMLImageElement).getAttribute('src')).toBe('/voices/uncle-fu.webp');
});

it('模型自带的其它音色（用户自己练的）不许乱配脸，仍走小圆点', async () => {
  routes({
    ...baseRoutes(),
    '/api/clone/templates': {
      items: [audioTpl({
        id: 15, name: '闪寻指定音色',
        slots: [{ kind: 'select', node: '37', input: 'speaker', label: '音色', options: ['my_voice'], value: 'my_voice' }],
        reference_cells: [],
      })],
    },
  });
  const screen = await ready({ image: AUDIO_CARD });
  expect(screen.querySelector('.cm-pill-face')).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '画面参数' }));
  const pop = await screen.findByRole('dialog', { name: '画面参数' });
  expect(pop.querySelectorAll('img.cm-ratio-face').length).toBe(0);
  expect(pop.querySelectorAll('.cm-ratio-flat').length).toBe(1);
});
"""


def patch(path, pairs):
    text = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert text.count(old) == 1, "anchor not unique in %s: %r" % (path, old[:60])
        text = text.replace(old, new, 1)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    print("patched", path)


patch(LIB, [(LIB_IMPORT_OLD, LIB_IMPORT_NEW), (LIB_ANCHOR, LIB_ADD)])
patch(MODAL, [(MODAL, MODAL)]) if False else None
text = io.open(MODAL, encoding="utf-8").read()
io.open(MODAL, "w", encoding="utf-8", newline="\n").write(text.rstrip("\n") + "\n" + MODAL_ADD)
print("appended", MODAL)
