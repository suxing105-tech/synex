import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealLocation } from '../lib/reveal';

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  (window as any).__TAURI__ = { core: { invoke } };
});

afterEach(() => {
  delete (window as any).__TAURI__;
});

describe('revealLocation', () => {
  it('桌面版走桌面壳，才能把资源管理器提到最前面', async () => {
    invoke.mockResolvedValue('D:\\a\\b.png');
    const fallback = vi.fn();
    await expect(revealLocation('D:\\a\\b.png', true, fallback)).resolves.toBe('desktop');
    expect(invoke).toHaveBeenCalledWith('reveal_path', { path: 'D:\\a\\b.png', select: true });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('打开监听目录时不要求选中文件', async () => {
    invoke.mockResolvedValue('D:\\ComfyUI\\output');
    await expect(revealLocation('D:\\ComfyUI\\output', false)).resolves.toBe('desktop');
    expect(invoke).toHaveBeenCalledWith('reveal_path', { path: 'D:\\ComfyUI\\output', select: false });
  });

  it('浏览器版回退到后端接口', async () => {
    delete (window as any).__TAURI__;
    const fallback = vi.fn().mockResolvedValue({ method: 'shell-select' });
    await expect(revealLocation('D:\\a\\b.png', true, fallback)).resolves.toBe('backend');
    expect(fallback).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('桌面版但路径已失效时仍尝试后端接口', async () => {
    const fallback = vi.fn().mockResolvedValue({ method: 'explorer-dir' });
    await expect(revealLocation('', true, fallback)).resolves.toBe('backend');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('两边都不可用就报错，不静默失败', async () => {
    delete (window as any).__TAURI__;
    await expect(revealLocation('', true)).rejects.toThrow('路径已失效');
  });

  it('桌面壳报错原样抛给调用方', async () => {
    invoke.mockRejectedValue(new Error('文件已经不在这个位置了，可能被移动或删除'));
    await expect(revealLocation('D:\\gone.png', true)).rejects.toThrow('已经不在这个位置');
  });
});