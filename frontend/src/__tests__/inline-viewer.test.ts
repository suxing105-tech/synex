import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { readFileSync } from "node:fs";
import { feedItems } from "../lib/stores";
import Lightbox from "../components/Lightbox.svelte";
import { clampPan } from "../lib/lightbox-zoom";
vi.mock("../lib/image-dims", async (original) => ({ ...await original<object>(), getOrientedImageSize: vi.fn().mockResolvedValue({w:1200,h:800}) }));
beforeEach(() => { feedItems.set([{id:1,filename:'a.png',width:1200,height:800,size_bytes:1024}, {id:2,filename:'b.png',width:1200,height:800,size_bytes:1024}] as any); });
afterEach(cleanup);
describe("中间区域图片预览", () => {
  it("切换适应/100%、切图重置、返回缩略图", async () => {
    const ui = render(Lightbox, {open:true,index:0,selectedId:1});
    expect(ui.getByRole('region',{name:'图片细节预览'})).toBeTruthy();
    await fireEvent.click(ui.getByRole('button',{name:'100%'}));
    expect(ui.getByRole('button',{name:'100%'}).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(ui.getByTitle('下一张'));
    expect(ui.getByRole('img').getAttribute('alt')).toBe('b.png');
    expect(ui.getByRole('button',{name:'适应窗口'}).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(ui.getByTitle('返回缩略图（Esc）'));
    expect(ui.queryByRole('region')).toBeNull();
  });
  it("图片双击只切换缩放，空白左键双击返回", async () => {
    const ui = render(Lightbox, {open:true,index:0,selectedId:1});
    await fireEvent.dblClick(ui.getByRole('img'), {button:0});
    expect(ui.getByRole('region')).toBeTruthy();
    expect(ui.getByRole('button',{name:'100%'}).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.dblClick(ui.container.querySelector('.viewer-canvas > div')!, {button:0});
    expect(ui.queryByRole('region')).toBeNull();
  });
  it("大图拖动可查看边缘，画布略小于图片时不产生反向偏移", () => {
    expect(clampPan({x:9999,y:-9999},{w:1200,h:800},{w:600,h:500},0)).toEqual({x:300,y:-150});
    expect(clampPan({x:0,y:0},{w:620,h:510},{w:600,h:500},0)).toEqual({x:0,y:0});
  });
  it("预览挂载在中间 main，按画布测量，无全屏或模糊遮罩", () => {
    const app=readFileSync('src/App.svelte','utf8');
    expect(app.slice(app.indexOf('<main'),app.indexOf('</main>'))).toContain('<Lightbox');
    expect(app).toContain('inert={lightboxOpen}');
    const viewer=readFileSync('src/components/Lightbox.svelte','utf8');
    expect(viewer).toContain('max-width: none');
    expect(viewer).toContain('bind:clientWidth={viewportW}');
    expect(viewer).toContain('bind:clientHeight={viewportH}');
    expect(viewer).not.toMatch(/backdrop-blur|fixed inset-0|window.innerWidth|window.innerHeight/);
  });
});
