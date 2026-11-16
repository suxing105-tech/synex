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

### 更新密钥只用一把，不换（2026-11-16 定稿）

发布通道与更新密钥就是本仓库这一套：`suxing105-tech/synex` + 公钥 `2544671ABFEF8FD0`，私钥是上面记的
`outputs\auto-update-v1\private\updater.key`（`F:\SeekX-Backups\auto-update-private\` 有同 mtime 的一份）。
已装客户端内嵌的就是这把公钥，换钥匙等于让所有老客户端从此验不上我们的更新、只能手动重装，所以不换。

fork `virsux/synex` 在 0.2.37 把自己的仓库名和新公钥 `8C00E93C8F6C6093` 写进了脚本与文档，并说
「旧私钥已丢失、仓库内与 `F:\` 备份都是空的、旧公钥是 Tauri 公开的测试密钥」。**三条都不成立**，
2026-11-16 复核过：仓库内和 `F:\` 两处都有 `updater.key` 与 `.pub`（同 mtime 2026-09-09 01:33），
两份 `.pub` 与 `tauri.conf.json` 里的 `pubkey` 逐字相同；公钥原文和 key id 在全网搜不到。
同一目录里另有一对同日生成的 `test.key` / `test.key.pub`（与 `pubkey` 不同），他们说的「测试密钥」
应当是认错了这一对。2026-11-15 合并 0.2.35–0.2.37 时没采纳它那笔发布口径（仓库地址与
`tauri.conf.json` 的 `pubkey` 全部退回本仓库原值），v0.2.38 就是用原来这把钥匙签的。

以后遇到 fork 或新机器要动这块，只需要回答一个问题：**私钥在不在**。在就沿用；
真不在才谈换钥匙，而换钥匙必须连「所有已装客户端手动重装一次含新公钥的版本」一起做完。
