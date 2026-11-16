# 发布与预览流程

一次改动的完整链路：改代码 → 全量门禁 → 预览包验收 → 签名发布 → 公网校验。
所有脚本都在 `frontend\scripts\`，更新签名私钥只记位置不入库。

## 0. 版本号

版本号有 6 处（`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`、`package.json`、
`pyproject.toml`、`backend/app/version.py`）。漏改一处曾让已安装的应用启动即变砖，
所以由 `backend/tests/test_version_consistency.py` 锁死，改版本只用脚本：

```powershell
python frontend\scripts\bump-version.py --to 0.2.21      # --from 省略即读 tauri.conf.json
```

脚本先全部读完校验、再一次性写入：任何一处不是「恰好 1 次命中」就整批不写。

## 1. 全量门禁

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\verify-all.ps1
```

依次跑后端 pytest、前端 vitest、svelte-check、cargo test，日志与
`VERIFY.txt` 落在 `outputs\verify-latest\`（已 gitignore），任何一套非零退出即失败。

## 2. 预览包（验收用，不发布）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\build-preview.ps1 -OutDir outputs\preview-v1 -Suffix '-v1'
powershell -NoProfile -ExecutionPolicy Bypass -File outputs\preview-v1\launch-preview.ps1 -CheckOnly
```

`build-preview.ps1` 第一步会跑 `fetch-media-tools.ps1`：把 `vendor\media-tools\`（或
`-SourceDir` / PATH 上找到的）`ffmpeg.exe` / `ffprobe.exe` 复制成
`src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe` 等，Tauri 再按 `externalBin`
安装成主程序同级的 `ffmpeg.exe` / `ffprobe.exe`。找不到就直接失败——没有它们，
别人机器上的视频海报、音频波形和视频里的 ComfyUI 提示词全是空的，而视频照样能播，
用户只会以为程序坏了。`app\` 里也会放一份，和安装后的目录布局一致。

产出 `app\`（主程序 + sidecar + ffmpeg + ffprobe）、`闪寻空间<-后缀>_x64-setup.exe`、
`闪寻空间-快捷启动.lnk`、`artifacts.json`（字节数 + sha256）、`DONE.txt`。
脚本会自己设置 `TAURI_SIGNING_PRIVATE_KEY`——Tauri 打包阶段就要给更新包签名。

## 3. 签名发布包

```powershell
# 先写 outputs\release-<版本>\release-notes.md
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\build-update.ps1 -OutputDirectory outputs\release-0.2.21
```

发布前自动跑版本一致性测试
打包前先确认 Tauri CLI 在（脚本里 `Assert-TauriCli` 会先报错）：

```powershell
cargo install tauri-cli                       # 得到 cargo tauri
cd frontend; pnpm add -D @tauri-apps/cli      # 得到 node_modules\.bin\tauri.cmd
```

两者选一个就行；脚本优先用本地的 `@tauri-apps/cli`，没有才回退到 `cargo tauri`。
，不一致直接中止。产出签名安装包、`.sig`、`latest.json`。

## 4. 推到 GitHub 并发 Release

顺序不能换：草稿 Release 的 `target_commitish` 取的是执行脚本时的本地 HEAD。

```powershell
git tag v0.2.21
git push origin HEAD:main
git push origin v0.2.21

python frontend\scripts\publish-release.py plan    --version 0.2.21 --dir outputs\release-0.2.21  # 不联网，只核对资产
python frontend\scripts\publish-release.py prepare --version 0.2.21 --dir outputs\release-0.2.21  # 建草稿 + 传资产
python frontend\scripts\publish-release.py publish --version 0.2.21 --dir outputs\release-0.2.21  # 复核校验和后设为 Latest
```

`prepare` 拒绝覆盖校验和不一致的已存在资产；`publish` 会重新逐个比对 sha256。
凭据走 `git credential fill`，脚本不打印也不落盘。

## 5. 公网校验

```powershell
python frontend\scripts\verify-public-release.py --version 0.2.21 --dir outputs\release-0.2.21
```

用已安装客户端读的同一个 `releases/latest/download/latest.json`，下载资产并比对
签名与本地文件，任何一项不符都非零退出。


## 更新签名私钥

- 仓库内：`outputs\auto-update-v1\private\updater.key`（已 gitignore，Git 不跟踪）
- 仓库外备份：`F:\SeekX-Backups\auto-update-private\`

丢了私钥就再也签不出能自动更新的版本（已发布客户端只认这把公钥）。
新增副本时同步更新上面两处路径的记录。

### 2026-11-15 重新生成了一次

旧公钥（`25446741BFDF8FD0`）是 Tauri 公开的**测试密钥**，不能用来签正式发布；
对应的私钥也已丢失（仓库内与 `F:\` 备份都是空的）。
本次重新生成了一对密钥，并把 `tauri.conf.json` 里的 `pubkey` 换成新公钥：

- 新密钥 ID：`8C00E93C8F6C6093`
- 生成命令：`pnpm tauri signer generate --ci -w outputs/auto-update-v1/private/updater.key`

**影响：旧版客户端内嵌的是旧公钥，验不上新密钥签的更新包。**
旧版必须手动安装一次含新公钥的版本（本次 v0.2.37 就是），之后才能走自动更新。

仓库名也从 `suxing105-tech/synex` 改到 `virsux/synex`（全部脚本、`tauri.conf.json`、
`updates.rs`、README 一并改完，`backend/tests/test_update_manifest.py` 也同步改了）。


## 2026-11-15 合并 virsux/synex（0.2.35–0.2.37）后，发布通道与密钥的口径

从 `virsux/synex` 合回来的那批改动里，有一笔 `781b1f1`「发布仓库换成 virsux/synex，更新签名私钥
重新生成」。**本次合并没有采纳这一笔的发布口径**，仓库地址与 `tauri.conf.json` 里的 `pubkey`
全部退回本仓库原值（`suxing105-tech/synex` + 公钥 `2544671ABFEF8FD0`），涉及：
`tauri.conf.json`、`updates.rs`、`make-update-manifest.py`、`publish-release.py`、
`verify-public-release.py`、`backend/tests/test_update_manifest.py`、README。

原因：本机 `outputs\auto-update-v1\private\updater.key`（连同 `.pub`，两者与上面那把公钥对得上）
是存在的，换密钥不是「本地补个公钥」就能了结的事——采纳他们的公钥，等于让已装客户端从此验不上
本通道签发的更新，而他们的私钥不在这个仓库里。

两点必须记清楚：

1. 上面「2026-11-15 重新生成了一次」那一节的说法（旧私钥丢失、仓库内与 `F:\` 备份都是空的）
   与本机实际情况不符：仓库内那把私钥在，`.pub` 也在，路径见「更新签名私钥」。
   他们说旧公钥是 Tauri 公开的测试密钥——**这条没查实**，留给苏醒判断。
2. 如果决定改用他们的通道与密钥（`virsux/synex` + `8C00E93C8F6C6093`），那是一次发布口径变更，
   要连「旧客户端必须手动装一次含新公钥的版本」一起做，不能只换脚本。
