# 发布清单（DSH 社区）

这个目录就是可直接推到 GitHub 公开仓库的内容。下面每一步做完再进下一步。

## 0. 发布前在本机验证

```sh
npm install
npm run build:client    # 从 src/entry.jsx 重新生成 lib/client.js
npm run check:client    # 已提交产物与源码一致
npm run smoke           # 结构 / 组合声明 / 注册 / 鉴权 / 状态读写 / 产物 六关
npm run check           # 语法
```

`scripts/smoke.mjs` 不起应用、不发网络请求、不碰真实会话数据：把 `$DSH_HOME` 指到临时目录，桩 ctx 跑 `apply` 验证工具与四条路由注册，用假 req/res 验证 403（非回环）、405（方法不对）、400（坏会话 id / 越界天数），再核对状态确实写进临时目录、`lib/client.js` 的外壳 id 与包名一致。任一条失败退出码 1。

## 0.5 检查打包内容

```sh
npm pack --dry-run
```

包里只应出现：`index.js`、`cordis.patch.yml`、`src/`、`lib/client.js`、`assets/`、`scripts/`、两个 README、`LICENSE`。`node_modules/`、`publish/`、`*.tgz` 都不该进包。

**`lib/client.js` 必须提交进 git。** 它不是构建垃圾：从 GitHub 安装时不跑构建，缺了它界面不会加载（宿主半边照常工作，菜单行、盾牌、设置行都不出现）。`.gitignore` 里不忽略 `lib/`。

## 1. 建 GitHub 仓库

- 公开仓库与包名同名：`dsh-session-autarchive`，安装命令写 `github:OWNER/dsh-session-autarchive`。
- 推送本目录内容。
- 给仓库加 topic：`dsh-plugin`（收录检查会看）。
- 仓库创建要满 1 天才能进目录（自动检查），当天建好、第二天再提 PR。

## 2. 填占位符

- `package.json` 的 `repository` / `homepage` / `bugs` 三处 URL（当前写的是 `taoziliyouchong`，换成你的 GitHub 用户名）。
- `publish/registry-entry.yml` 的三处 URL 和 `name`。
- 若走 npm，先确认包名可用：`npm view dsh-session-autarchive version`（当前 404，未被占用）。

## 3. 发布到 npm（可选但推荐）

```sh
npm publish --access public
```

不发 npm 也能被收录：安装命令走 GitHub。发 npm 的好处是市场能做版本更新检查。

## 4. 提交目录收录

到 GitHub 仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 开 PR，只加一个文件：

- 路径：`data/plugins/<OWNER>__dsh-session-autarchive.yml`
- 内容：`publish/registry-entry.yml` 去掉占位后的全文

分类填 `session`。不要动包里代码；README 中英两份内容保持同步。

## 5. 之后的版本更新

1. 改 `package.json` 的 `version`（语义化版本）。
2. 改了界面就重新 `npm run build:client`，把 `lib/client.js` 一起提交。
3. 打 tag：`git tag v0.1.1 && git push --tags`。
4. `npm publish`（如果走 npm）。
5. 目录条目本身不用改，市场按 npm 版本或 GitHub HEAD 检查更新。

## 收录要求对照

| 要求 | 本仓库状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` | 已声明，指向 `cordis.patch.yml` |
| 仓库有真实可用代码 | 有（宿主判定与归档、四条路由、工具、客户端界面） |
| 仓库满 1 天 | 建库后次日再提 PR |
| 加 `dsh-plugin` topic | 建库时加 |
| 描述只说功能、不夸大 | `registry-entry.yml` 按实际能力写 |
| 分类贴合 | `session` |
| 客户端半边可复现 | `lib/client.js` 已提交，`npm run check:client` 可核对 |

## 已知注意事项

- 默认开启、阈值 5 天：装好就会开始归档。README 里写明，别在说明里漏掉。
- 同一组界面座位只能挂一份；同时装另一个自动归档插件会出现重复的菜单行和设置行。
- 自测安装会改动你的真实会话：先用 `dryRun: true` 跑一次工具确认候选，或临时把 `days` 调到很大。
