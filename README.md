# 时间码字幕生成工具2.0

把本地音频、带音轨的视频转为带时间码字幕，供 Codex 制作视频，并在剪映中按原视频时间线替换画面。

## 交付文件

| 文件 | 用途 |
| --- | --- |
| `当期中文主题_自动时间码字幕.srt` | 可导入剪映的句级字幕 |
| `当期中文主题_自动动效时间轴.json` | 兼容 Remotion `Caption[]` 的句子与词元时间，附绝对起止帧 |
| `当期中文主题_视频对齐信息.json` | 原视频总时长、目标帧率、总帧数、停顿间隙和待复核位置 |

三份文件使用同一份当期文案的中文主题，例如 `2027年买新房还是二手房_自动时间码字幕.srt`。Skill 优先使用当期已确认的标题或期名，否则从文案概括中文主题；只有媒体时先临时识别，再根据正文确定主题并统一归档。不以英文媒体名、随机编号或哈希作为最终文件名。

制作整片时读取 `视频对齐信息.json` 中的 `composition.fps` 和 `composition.durationInFrames`。字幕末尾只表示最后一句话结束，不能用它决定成片长度。所有时间都从原文件播放起点计算；保留开头、句间和尾部空白。拼接时不能把字幕段时长相加后紧接着排放。

例如源视频 128 秒、30fps，而最后一句结束在 127.063 秒：整片仍应渲染 3840 帧。句子和关键词按 JSON 的 `startFrame` / `endFrame` 放入对应位置。截取片段时，统一减去该片段起点。

## 使用

Codex Skill 调用名保持为 `$generate-timestamped-subtitles`，界面名称为“时间码字幕生成工具2.0”。

```bash
node "<Skill目录>/scripts/doctor.mjs"
node "<Skill目录>/scripts/run.mjs" "/完整路径/视频.MOV" "当期中文主题" "/输出目录"
```

输出目录可以省略，默认输出到输入文件旁的 `字幕文件/`。输入文件名本身就是当期中文主题时，可以省略主题参数；英文名或随机编号的输入必须明确传入中文主题。视频默认沿用可确认的源帧率；纯音频或可变帧率视频默认以 30fps 规划生成视频。需要其他目标帧率时明确指定：

```bash
node "<Skill目录>/scripts/run.mjs" "/完整路径/视频.MOV" "当期中文主题" --fps 30000/1001
```

`视频对齐信息.json` 的 `fpsSource` 会记录帧率来自原视频、用户设置还是默认值。可变帧率视频按原文件播放时间对齐，目标渲染为固定帧率，无法保证源视频每一帧都一一对应；目标时长向上覆盖到完整一帧。

## 对齐方式与限制

- 先用 ffprobe 读取源视频播放时间、音轨偏移、完整时长和帧率，视频轨作为替换画面的长度依据。
- 音轨转为 16kHz PCM，保留时间戳间隙；只在时间线末端补静音或裁去超出视频的部分，不加速语音、不删除停顿。
- 有适合的停顿时，约每 20 秒切成识别段，各段仍映射回原视频的绝对时间；没有合适停顿时不强行切断发音。
- 使用现有 Whisper.cpp 1.5.5 多语言模型进行 DTW 词元估计，并利用附近静音修正句子边缘；不按中文字数平均分配时间。分段用于限制长段识别影响，不构成精度保证。
- UTF-8 分裂词元先还原为完整中文，再保存时间。异常边界明确回退或合并，不能无提示丢字。
- 起止帧分别从绝对时间换算，时长取二者之差；不累计各段取整误差。极短词元可能不足一帧，不能独立安排一帧以上动画。
- `timestampMs` 是对齐点，动画定位使用 `startMs` / `startFrame`。所有 `endFrame` 均为不含该帧的结束边界。
- 自动词元时间仍是估计，当前 DTW 网格为 20ms。总时长与结构检查通过不代表逐字声学边界已获验证；制作关键动作前应听原视频核对开头、中间、结尾和 `alignment.review` 标记。
- 自动识别可能出现同音字或繁体字。正文校对需同时修改 SRT、JSON 句子与相应 `tokens`，仅改字时保持全部时间与帧数。

## 依赖与安装

需要 Node.js 18+、可执行的 ffmpeg、ffprobe、Whisper.cpp 1.5.5 和多语言 `small` 模型。已有程序和模型优先复用，本仓库不包含模型、可执行程序、用户视频、用户字幕或缓存。

`doctor.mjs` 只读检查。已有完整环境时不需要安装 npm 运行包；可通过以下环境变量指定现有文件：

- `CODEX_SUBTITLE_RUNTIME_DIR`：运行目录，其中 `whisper.cpp/main`（Windows 为 `main.exe`）和 `whisper.cpp/ggml-small.bin` 可直接复用。
- `CODEX_SUBTITLE_MODEL_PATH`、`CODEX_SUBTITLE_WHISPER_EXECUTABLE`：独立指定已有模型、程序。
- `CODEX_FFMPEG_PATH`、`CODEX_FFPROBE_PATH`：可选媒体程序路径，优先于系统命令及缓存中的程序。

尚无环境时，`setup.mjs` 使用独立缓存，依赖清单固定在 `scripts/runtime-package.json`。默认模型约 466MB，首次完整环境通常需要约 0.7–1GB 以上磁盘空间，按平台变化。已有模型无需复制或重新下载：

```bash
node "<Skill目录>/scripts/setup.mjs" --model-path "/已有/ggml-small.bin"
```

只有用户授权下载模型后才使用 `--download-model`；只有授权安装缺失系统工具后才添加 `--install-system-deps`。脚本不修改 shell 配置。

缓存默认按当前系统用户定位到 macOS `Library/Caches`、Windows `LOCALAPPDATA` 或 Linux `XDG_CACHE_HOME`。临时音轨与原始识别文件在系统临时目录创建，结束后自动清除。输入文件只读，SHA-256 用于确认后续视频使用了同一份源文件。

## 检查

```bash
node --test scripts/alignment.test.mjs scripts/media-clock.test.mjs
```

检查覆盖中文词元还原、停顿、时间回退、绝对帧换算、128 秒视频长度、分数帧率、音轨延迟、实际音轨时间戳间隙和尾部静音。真实媒体测试需要可用的系统 ffmpeg 与 ffprobe。

## 版本与依据

本仓库为 **2.0.0**。旧版保持在 [生成带时间码字幕原仓库](https://github.com/pensongchs/shengcheng-shijianma-zimu-skill)。两版分仓保留；本地使用 2.0 时保持原 Skill 调用名。

时间戳处理参考 [FFmpeg 时间戳选项](https://ffmpeg.org/ffmpeg.html) 与 [音频重采样过滤器](https://ffmpeg.org/ffmpeg-filters.html#aresample-1)。DTW 能力与边界限制参考 [Whisper.cpp 1.5.5](https://github.com/ggml-org/whisper.cpp/tree/v1.5.5)。
