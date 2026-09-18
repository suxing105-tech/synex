import { afterEach, describe, expect, it, vi } from "vitest";
import { copyOriginalImage, originalImagePng } from "../lib/image-clipboard";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
