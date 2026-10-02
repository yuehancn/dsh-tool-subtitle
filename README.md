# 字幕工具箱 —— 给 dsh 一套真的能改时间轴的字幕工具

> **转写、互转、校时、体检** —— 把音频变成带时间戳的字幕，把 SRT 换成 ASS，
> 把整体偏移 2.5 秒的字幕对齐回去，在出片前先查一遍有没有「一句 20 秒」。

给 **DeepSeek Harness** 用的自建工具插件：7 个结构化工具，把字幕这件事从
「一堆正则」变成「能问能改」。

> **Compatibility**: built and tested against dsh `0.2.0-rc.2` (preview).
> The `apply(ctx)` plugin spec is stable; verify against your own dsh version if newer.

---

## 一行安装

```bash
dsh plugin --profile desktop add github:yuehancn/dsh-tool-subtitle
```

**支持的 profile**：`desktop`（桌面版）/ `web`（Web 版）。装完重启 dsh 即可用。

---

## 为什么需要它

字幕是**格式知识 + 时间轴算术**，两样都容易做错：

- 三种方言的**时间戳语法各不相同** —— SRT 用逗号、VTT 用点、ASS 用**厘秒**
  且小时只有一位。写错一个字符，播放器直接不认。
- ASS 的 `Dialogue:` 字段顺序**由 `Format:` 行声明**，真实文件会重排字段；
  按位置硬读就会把「样式名」读成「开始时间」。
- 「字幕比声音快 2.5 秒，而且越到后面差得越多」是一个**纯算术**问题
  （`时间 × 1.015 + 2.5`），但每次都要重新推导一遍。

这个插件把这些收进工具里。**不 mock 一个字节**：解析器能吃真实世界里的脏文件，
时间轴运算有 291 条断言对着真实 `@deepseek-ai/dsh-tools` 和真实子进程跑过。

---

## 七个工具

| 工具 | 干什么 |
|---|---|
| `subtitle_status` | 探本机有没有可用的识别引擎，列出能读写的方言 |
| `subtitle_read` | 把字幕读成**带数字时间戳的结构化 cue 列表** |
| `subtitle_write` | 把 cue 列表写成文件（时间戳可以给秒数，也可以给字符串） |
| `subtitle_convert` | SRT ↔ VTT ↔ ASS 互转，可顺带校时/合并/拆分 |
| `subtitle_retime` | 整体位移 + 缩放，专治「偏移」和「漂移」 |
| `subtitle_check` | 出片前体检：过长、过短、读不过来、重叠、空文本、繁体 |
| `subtitle_transcribe` | 用你配置的识别引擎把音视频转成字幕 |

### 为什么 `subtitle_read` 返回 JSON 而不是一大段文本

因为「把字幕转成文本」用 `cat` 就够了，模型真正需要的是**能推理的时间轴** ——
哪两句挨得太近、那句 20 秒的有多长、第 47 条后面有没有空洞。这些都要数字。

### 为什么 `subtitle_retime` 单独成一个工具

「偏移 2.5 秒」和「漂移 1.5%」在实操里同时出现，正确答案是
`时间 × factor + offset` 一个式子。把它做成工具，模型就不用每次自己推导。

### `subtitle_check` 查什么

| 问题 | 判据（可配） |
|---|---|
| `too-long` | 单条超过 `maxCueSeconds`（默认 7 秒） |
| `too-short` | 单条短于 `minCueSeconds`（默认 0.8 秒） |
| `too-fast` | 阅读速度超过 `maxCharsPerSecond`（默认 9/秒） |
| `overlap` | 两条字幕时间重叠（多数播放器会糊成一团） |
| `non-positive-duration` | 结束不晚于开始 |
| `empty-text` | 没有文字 |
| `possible-traditional-chinese` | 出现繁体专用字（ASR 常见坑） |

阅读速度按**汉字逐字 + 拉丁词逐词 + 数字逐位**算 —— 因为观众读 `2026`
是读四个符号，不是读一个词。

---

## 配置

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: tool-subtitle
  config:
    outputDir: C:/Users/you/Videos/subtitle-output
    # 识别引擎：任何会写出 SRT 的可执行文件
    asrCommand: C:/Users/you/.local/bin/whisper-faster.exe
    asrArgs:
      - "{input}"
      - "--model"
      - "{model}"
      - "--output_dir"
      - "{dir}"
      - "--output_format"
      - "srt"
      - "--language"
      - "{lang}"
    asrModel: D:/models/whisper        # 也可以填 large-v3
    asrLanguage: zh
```

`asrArgs` 里的占位符：

| 占位符 | 含义 |
|---|---|
| `{input}` | 输入的音视频绝对路径 |
| `{output}` | 期望的 SRT 绝对路径 |
| `{dir}` | 插件输出目录 |
| `{lang}` | 识别语言 |
| `{model}` | 模型名或路径 |

| 配置项 | 默认 | 说明 |
|---|---|---|
| `outputDir` | `subtitle-output` | 产物目录 |
| `timeoutMs` | 1800000 | 单次调用预算（30 分钟，转写很慢） |
| `asrCommand` | 空 | 留空则禁用转写，其余工具照常可用 |
| `asrModel` / `asrLanguage` | `large-v3` / `zh` | 传给 `{model}` / `{lang}` |
| `asrEnv` | `[]` | 给引擎进程的额外环境变量，`"KEY=VALUE"` 形式 |
| `maxCueSeconds` / `minCueSeconds` | 7 / 0.8 | 体检阈值 |
| `maxCharsPerSecond` | 9 | 阅读速度上限 |
| `maxCues` | 500 | 单次最多内联返回多少条 |
| `status`/`read`/`write`/`convert`/`retime`/`transcribe`/`check` | `true` | 按需关掉某个工具 |

**不配 `asrCommand` 也能用** —— 读、写、转换、校时、体检都是纯本地运算，
不依赖任何外部引擎。

---

## 兼容性说明

- **引擎无关**：本插件不绑定 faster-whisper。任何「接受输入路径、写出 SRT」的
  命令都能接 —— whisper.cpp、openai-whisper、内部 ASR 服务客户端都行。
- **引擎不认 `{output}` 时会自动归位**：很多引擎只有 `--output_dir`（文件名由它自己定），
  此时插件会把产物**改名到你要求的 `outputName`**，而不是让你去猜它写哪儿了。
- **引擎静默失败会被抓到**：跑完却没写出 SRT 时，报错里会带上**实际执行的完整命令行**，
  让你知道是参数不对还是路径没写对。

---

## 安全说明

- 只用 `spawn(command, argsArray)` —— **不拼 shell 字符串**，
  路径里有空格、引号、中文都不会出事（有专门的中文带空格用例）。
- 只读写你指定的输入文件与 `outputDir`，不上传、不联网。
- 识别引擎是**你自己配置的**可执行文件，插件不下载、不安装任何东西。

---

## 跑测试

```bash
mkdir -p node_modules/@deepseek-ai
cp -r "$HOME/.dsh/profiles/desktop/node_modules/@deepseek-ai/." node_modules/@deepseek-ai/
node _test/run-all.mjs
```

三个套件，**291 条断言全绿**（对着真实 `@deepseek-ai/dsh-tools` 跑，不 mock）：

| 套件 | 断言 | 内容 |
|---|---|---|
| `test-logic.mjs` | 162 | 三套时间戳语法与往返、SRT/VTT/ASS 解析（含 CRLF/BOM/缺索引行/字段重排/卡拉OK标签）、三套序列化与跨方言往返、阅读速度、排序重编号、位移/缩放、拆分、合并、7 类体检、占位符展开、cue 强制转换 |
| `test-integration.mjs` | 84 | 模块导出、注册数量、`defineTool` schema 归一化、七个开关、18 条错误路径、卡片标题、输出渲染 |
| `test-e2e.mjs` | 45 | 真的起子进程当识别引擎 → 真写 SRT → 真解析；引擎不可达/退出非零/静默无输出的三种诊断；`transcribe → check → 拆分 → 校时 → VTT → ASS → 读回` 全链路；中文带空格路径 |

`test-e2e.mjs` 用一个自带的替身引擎 `_test/fixtures/mock-asr.mjs`，
所以**不需要装任何模型**就能跑，也不需要联网。

---

## 许可

MIT