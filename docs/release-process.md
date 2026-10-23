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

产出 `app\`（主程序 + sidecar）、`闪寻空间<-后缀>_x64-setup.exe`、
`闪寻空间-快捷启动.lnk`、`artifacts.json`（字节数 + sha256）、`DONE.txt`。
脚本会自己设置 `TAURI_SIGNING_PRIVATE_KEY`——Tauri 打包阶段就要给更新包签名。

## 3. 签名发布包

```powershell
# 先写 outputs\release-<版本>\release-notes.md
powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\build-update.ps1 -OutputDirectory outputs\release-0.2.21
```

发布前自动跑版本一致性测试，不一致直接中止。产出签名安装包、`.sig`、`latest.json`。

## 4. 推到 GitHub 并发 Release

顺序不能换：草稿 Release 的 `target_commitish` 取的是执行脚本时的本地 HEAD。

```powershell
git tag v0.2.21
git push origin codex/tauri-app
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