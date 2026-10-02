---
name: generate-timestamped-subtitles
description: Generate Chinese SRT captions and a Remotion Caption JSON timeline from local audio or video using Whisper.cpp. Use for speech transcription with timecodes, subtitle export, or aligning video text and animation to speech. Fine token timing is embedded in the main JSON; automatic alignment remains an estimate.
---

# 生成带时间码字幕

默认只交付两份可直接用于制作视频的文件，用户可以把这两份一起交给 Codex：

- `*_自动时间码字幕.srt`：完整句级字幕与起止时间，可用于分镜定位或导入剪辑软件。
- `*_自动动效时间轴.json`：保持 Remotion `Caption[]` 数组结构，与 SRT 逐句一致。每条字幕的 `tokens` 包含完整中文词元的精细时间，用于定位关键词、数字和动效；词元可能包含多个汉字。

精细时间合并在主 JSON 内，校验由脚本内部完成。不默认生成或交付独立精细时间轴、校验报告或纠错文件；只有用户明确要求报告时才额外导出。

## 首次运行

运行环境安装在当前电脑用户的系统缓存目录，并由脚本根据 macOS、Windows 或 Linux 自动定位。重复使用时不会再次下载完整模型。

首次使用前：

1. 运行只读检查：

   ```text
   node "<本 Skill 目录>/scripts/doctor.mjs"
   ```

2. 先用只读方式检查本机是否已有 `ggml-*.bin` 模型。优先检查用户明确提供的位置、当前项目和当前用户常用缓存目录；不要为了搜索模型修改、复制或移动任何文件。
3. 如果找到已有模型，复用其完整路径：

   ```text
   node "<本 Skill 目录>/scripts/setup.mjs" --model-path "<本机已有 ggml-*.bin 的完整路径>" --install-system-deps
   ```

4. 如果未找到模型，先告诉用户需要下载和安装的内容：
   - npm 运行依赖和独立 ffmpeg：约 80—150MB。
   - Whisper.cpp 源码与编译产物：约 100—300MB。
   - 默认中文 `small` 模型：约 466MB。
   - 总磁盘占用通常约 700MB—1GB，具体取决于平台。
5. 只有用户明确同意下载模型后，才能运行：

   ```text
   node "<本 Skill 目录>/scripts/setup.mjs" --download-model --install-system-deps
   ```

6. 没有 `--download-model` 时，脚本发现模型缺失会直接停止；不得擅自补上该开关。
7. macOS/Linux 使用本地编译的 Whisper.cpp；Windows 自动下载官方预编译程序。macOS 如果弹出“命令行开发者工具”安装窗口，提醒用户完成系统安装，然后再次运行同一条命令。
8. `setup.mjs` 必须完成 npm 依赖、独立 ffmpeg、Whisper.cpp、已有模型接入和自检后，才能开始转写。不要仅凭文件夹存在就宣布安装成功。

## 生成字幕

1. 确认用户提供了本地音频或视频路径。没有明确成品名时沿用源文件名。
2. 运行：

   ```text
   node "<本 Skill 目录>/scripts/run.mjs" "<当前电脑上的音频或视频完整路径>" "可选成品名" "可选输出目录" [--fps 30]
   ```

3. `run.mjs` 会自动检查运行环境；环境不完整时会停止并提示先运行 `setup.mjs`，不会输出假成品。可追加目标视频帧率 `--fps 30`，JSON 会附对应帧率、绝对起止帧和帧数；不使用源文件帧率推断动效工程帧率。
4. 等待转写完成，不要中途结束进程。默认中文 `small` 模型在本地运行，长音频需要一定时间。
5. 从命令输出中读取两份成品的绝对路径并交付给用户。
6. 制作视频时，SRT 或 JSON 顶层条目用于句级定位；关键词和动效用各条目的 `tokens.startMs`/`tokens.endMs`。校验提示内部处理，有影响使用的异常只需一句话说明，交付文件仍为两份。
7. 仅校正同音字、姓名、地名或专业词时保留时间码，并同步两份文件及对应词元文本。正文与实际配音不同时不能硬套时间轴；用户明确要求校时后，根据原音频局部修正并同步两份成品。

## 时间精度与视频对齐

- 毫秒是保存单位，不代表 1 毫秒识别准确度。当前 Whisper.cpp DTW 对齐网格为 20 毫秒，实际误差仍受语速、吞音、音乐和识别错误影响。
- 脚本读取全部语音词元，合并不完整的中文 UTF-8 字节，使用相邻 DTW 转换点估计区间，句首句尾按附近可检测的静音局部修正。缺失或异常对齐点明确回退或合并并保留正文，不丢字、不按字数平均分配时间、不随意整体平移。
- `timestampMs` 为单个对齐点，不等同于发音开始；字幕和动画使用 `startMs` 定位。正式制作前，核对原音频的开头、中间、结尾及低置信度、长词元或回退边界。未经听音或人工参照，不声称逐帧准确。
- 时间零点为原文件播放起点，提取音轨保留起始偏移与内部时间间隙。转为帧时分别计算 `startFrame = round(startMs * fps / 1000)`、`endFrame = round(endMs * fps / 1000)`，时长取二者之差；不累计各段取整后的时长。截取片段时，全部局部时间减去同一个经确认的片段起点，保留片段内停顿。

## 路径与依赖规则

- 脚本必须通过自身位置定位 Skill，禁止写死用户名、主目录或项目路径。
- macOS 默认使用当前用户的 `Library/Caches/codex-generate-timestamped-subtitles/`。
- Windows 默认使用当前用户的 `LOCALAPPDATA/codex-generate-timestamped-subtitles/`。
- Linux 默认使用当前用户的 `XDG_CACHE_HOME` 或 `.cache/codex-generate-timestamped-subtitles/`。
- 默认输出到输入文件旁边的 `字幕文件/`；用户提供第三个参数时使用指定目录。
- 输入文件只读；临时 WAV 存放在系统临时目录，结束后自动清理。
- 已有模型只以原路径读取，不复制、不移动、不改名、不重复下载。
- 模型缺失时默认停止；只有用户明确授权后才能通过 `--download-model` 下载。
- npm 使用本 Skill 运行环境中的专用缓存目录，不依赖当前用户的全局 npm 缓存权限。
- 需要安装系统级 Node.js、Git 或编译工具时必须先获得用户同意。`setup.mjs --install-system-deps` 只补齐当前平台确实需要的依赖，不修改 shell 配置，也不保存管理员密码。
- 运行入口统一为 Node.js；Windows 不需要 Git Bash。若 Codex 能提供内置 Node.js，优先直接使用该运行时，避免重复安装系统 Node.js。

## 验收

- `doctor.mjs` 最终输出“运行环境检查通过”，并显示当前实际使用的模型路径。
- 转写命令退出码为 0。
- `.srt` 和 `.json` 都已生成且非空。
- SRT 至少包含序号、`开始时间 --> 结束时间` 和字幕正文。
- JSON 顶层为可正常解析的数组，每条包含 `text`、`startMs`、`endMs`、`timestampMs` 和内嵌 `tokens`。
- SRT 与 JSON 的条目数量、正文、顺序、起止逐条一致；每条 `tokens` 拼接正文与所属句子一致，时间区间在句内且无重叠。
- 退出成功且两份输出合法只确认自动生成成功，不等同于听音准确率验收。
- 修改边界算法后运行 `node "<本 Skill 目录>/scripts/alignment.test.mjs"`；修改交付结构后，用真实媒体核对两份成品及内嵌精细时间。
- 输出路径只来自当前电脑的输入文件、用户指定目录或当前用户缓存目录。
