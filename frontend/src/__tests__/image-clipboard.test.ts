import { afterEach, describe, expect, it, vi } from "vitest";
import { copyDataUrlImage, copyOriginalImage, downloadBlob, originalImagePng } from "../lib/image-clipboard";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('复制与下载任意图片', () => {
  it('data URL 走同一条 PNG 转换路径', async () => {
    const bitmap = { width: 64, height: 40, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })) };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as any);
    let data: Record<string, Promise<Blob>> = {};
    vi.stubGlobal('ClipboardItem', class { constructor(value: typeof data) { data = value; } });
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { write } });
    await copyDataUrlImage('data:image/jpeg;base64,QUJD');
    expect([canvas.width, canvas.height]).toEqual([64, 40]);
    expect((await data['image/png']).type).toBe('image/png');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('下载用文件名落地，不污染剪贴板', () => {
    const anchor = { href: '', download: '', click: vi.fn() };
    const spy = vi.spyOn(document, 'createElement').mockReturnValue(anchor as any);
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(document.body, 'appendChild').mockImplementation(() => document.body);
    vi.spyOn(document.body, 'removeChild').mockImplementation(() => document.body);
    downloadBlob(new Blob(['j'], { type: 'image/jpeg' }), 'clip-P02-last.jpg');
    expect(anchor.download).toBe('clip-P02-last.jpg');
    expect(anchor.click).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('不支持图片剪贴板时明确报错', async () => {
    vi.stubGlobal('navigator', { clipboard: {} });
    await expect(copyDataUrlImage('data:image/jpeg;base64,QUJD')).rejects.toThrow('不支持');
  });
});

describe('复制原图', () => {
  it('请求无缩略尺寸参数的原图，PNG 内容原样写入剪贴板', async () => {
    const blob=new Blob(['original'],{type:'image/png'});
    const request=vi.fn().mockResolvedValue({ok:true,blob:async()=>blob});vi.stubGlobal('fetch',request);
    let data: Record<string,Promise<Blob>> = {};
    vi.stubGlobal('ClipboardItem',class {constructor(value:typeof data){data=value;}});
    const write=vi.fn().mockResolvedValue(undefined);vi.stubGlobal('navigator',{clipboard:{write}});
    await copyOriginalImage(7);
    expect(request.mock.calls[0][0]).toMatch(/\/api\/images\/7\/file$/);
    expect(await data['image/png']).toBe(blob);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('非 PNG 保留原始宽高转换，不缩成预览图', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(['jpeg'],{type:'image/jpeg'})}));
    const bitmap={width:4200,height:2800,close:vi.fn()};vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));
    const canvas={width:0,height:0,getContext:()=>({drawImage:vi.fn()}),toBlob:(cb:(b:Blob)=>void)=>cb(new Blob(['png'],{type:'image/png'}))};
    vi.spyOn(document,'createElement').mockReturnValue(canvas as any);
    expect((await originalImagePng(8)).type).toBe('image/png');
    expect([canvas.width,canvas.height]).toEqual([4200,2800]);expect(bitmap.close).toHaveBeenCalled();
  });
  it('剪贴板不支持或写入失败时拒绝，不复制链接',async()=>{
    const writeText=vi.fn();vi.stubGlobal('navigator',{clipboard:{writeText}});
    await expect(copyOriginalImage(1)).rejects.toThrow('不支持');expect(writeText).not.toHaveBeenCalled();
  });
});
