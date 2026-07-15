# 实时金价监控 + 智能调仓推送

一个零依赖的单文件网页应用：实时显示国内/国际金价，记录你的交易与持仓，
在价格触及 **补仓 / 止盈 / 止损** 档位时，通过微信（Server酱）推送调仓提醒。

- 网页：`index.html`（直接用浏览器打开，数据存浏览器 localStorage）
- 后台推送：`monitor.js`（Node 18+，零依赖，可跑在 GitHub Actions 上 24/7）

## 一、本地使用网页

直接用浏览器打开 `index.html` 即可。所有数据保存在本机浏览器。

- 添加交易记录（支持文本批量导入）
- 在「策略」里设置止损/止盈比例、补仓档位间隔、每档克数
- 在「推送」里填 Server酱 key 并开启，页面打开时到档位会自动推送微信

## 二、把配置交给后台（关机也能推送）

网页里点 **「导出监控配置」**，会下载一个 `monitor-config.json`。
后台 `monitor.js` 需要这份配置才能算持仓和档位。

### 本地常驻（电脑开机时）

```bash
# 把导出的 monitor-config.json 放到同目录
node monitor.js                 # 默认每 5 分钟检查一次
INTERVAL=300 node monitor.js    # 自定义间隔（秒）
```

### GitHub Actions 全天候（推荐，电脑关机也跑）

1. 把本仓库推到 GitHub（公开仓库 Actions 免费不限时）。
2. 把导出的 `monitor-config.json` 做 base64 编码：
   - Windows(PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("monitor-config.json"))`
   - Mac/Linux: `base64 -w0 monitor-config.json`
3. 仓库 **Settings → Secrets and variables → Actions → New repository secret**：
   - 名称 `MONITOR_CONFIG_B64`，值填上面的 base64 串
   - （可选）名称 `SCT_KEY`，值填 Server酱 key（与配置里的 push.key 二选一）
4. 开启 **Settings → Actions → General → Workflow permissions → Read and write**。
5. **Actions** 页面手动 **Run workflow** 测一次，看日志是否成功推送。

之后 GitHub 每 5 分钟自动抓价、算档位、推送微信，与电脑无关。
监控状态（`monitor-state.json`）会自动提交回仓库，避免重复推送。

> 想临时改策略/持仓，重新导出配置 → 重新生成 base64 → 更新 Secret 即可。

## 三、用 GitHub Pages 在线访问网页

仓库 **Settings → Pages → Build and deployment → Source: Deploy from a branch**，
选 `main` 分支、`/ (root)`，保存。几分钟后 `https://<用户名>.github.io/<仓库名>/`
就是在线版网页，手机/任意电脑都能打开看金价和持仓。

## 配置字段说明

| 字段 | 含义 |
|---|---|
| `mode` | `domestic`（元/克）或 `international`（美元/盎司） |
| `strategy.stopLoss` | 止损线，相对均价下跌百分比 |
| `strategy.takeProfit` | 止盈线，相对均价上涨百分比 |
| `strategy.addDrop` | 补仓档位间隔（每跌这么多 % 为一档） |
| `strategy.addTranche` | 每档建议买入克数（计划表用） |
| `strategy.sellRatio` | 止盈时建议卖出比例 % |
| `strategy.premium` | 国内溢价 %（国际价换算国内时加上） |
| `transactions[].type` | `buy` / `sell` |
| `transactions[].price` | 单价（元/克 或 美元/盎司） |
| `transactions[].grams` | 克数 |
| `transactions[].fee` | 手续费 |
| `push.channel` | `serverchan`（Server酱）或 `wecom`（企业微信机器人） |
| `push.key` | 对应 key / webhook key |

## 数据接口

- 国际金价：`https://api.gold-api.com/price/XAU`
- 美元兑人民币：`https://open.er-api.com/v6/latest/USD`
- 国内价 = 国际价(美元/盎司) ÷ 31.1035 × 汇率 × (1 + premium%)
