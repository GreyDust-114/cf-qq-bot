# 本地贴纸素材（BOT-021）

将获准使用的 PNG/JPEG 素材放在本目录；图片不提交到 Git。文件名默认作为模型可选名称（最多 32 个 Unicode 字母/数字、`_` 或 `-`）。可复制 `manifest.example.json` 为本地 `manifest.json` 配置标签与展示名。

```sh
node tools/import-stickers.mjs stickers > local/stickers.sql
npx wrangler d1 execute qq-ai-bot-db --local --file local/stickers.sql
```

生成的 SQL 含图片 base64，只存本机并妥善处理。先在本地 D1 验证；应用 `0007_sticker_assets.sql` 后再导入。向生产 D1 执行迁移或素材 SQL 前须单独获得用户明确授权。运行时上传使用 `STICKER_MEDIA_BASE_URL` 指向可被 QQ 服务端访问的 Worker HTTPS 地址。
