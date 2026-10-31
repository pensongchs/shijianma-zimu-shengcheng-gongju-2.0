---
name: generate-timestamped-subtitles
description: Generate Chinese timecoded SRT and Remotion caption timelines from local audio or video, preserving the source playback clock, pauses, full video duration and frame positions for editing or replacing video in Jianying. Use for subtitle extraction and matching video animation to recorded speech.
---

# 时间码字幕生成工具2.0

生成三份成品：`*_自动时间码字幕.srt`、`*_自动动效时间轴.json` 和 `*_视频对齐信息.json`。句级 JSON 保持 Remotion `Caption[]`，每条包含完整词元 `tokens`、绝对毫秒及帧位置；对齐信息保存完整源视频时长、目标帧率、总帧数、停顿与待复核位置。

## 执行

1. 优先复用用户当前项目的同版本字幕工具及其现有模型。没有现有入口时，从本 Skill 的 `scripts/doctor.mjs` 检查环境。缺失项目、实际模型路径应按检查结果报告，不把目录存在当成可用。
2. 完整环境可直接运行，不安装、不重复下载：

   ```bash
   node "<本 Skill 目录>/scripts/run.mjs" "<音频或视频完整路径>" "当期中文主题" "可选输出目录" [--fps 30]
   ```

   输出目录可省略，默认位于输入文件旁的 `字幕文件/`。仅当输入文件名本身就是当期中文主题时，才可省略主题参数；英文名或随机编号的输入必须传入中文主题。视频用于原画面替换时默认沿用可确认的源帧率；用户已有目标工程帧率时用 `--fps` 明确指定，可填写 `30000/1001`。纯音频和可变帧率源默认目标 30fps，并在对齐信息记录。
3. 环境缺失时先核对现有程序和模型，按 README 的环境变量引用实际位置。确需安装时读取 `scripts/runtime-package.json`；`setup.mjs --model-path "<已有模型>"` 可复用模型。需下载模型或系统安装且尚无授权时，说明用途、来源、缓存位置和体积后再询问。模型约 466MB，完整运行环境通常需 0.7–1GB 以上；只在用户授权时加 `--download-model` 或 `--install-system-deps`。
4. 等待退出，回读三份成品。核对 SRT 与 Caption JSON 的句数、正文、顺序、起止一致，词元拼接与句子一致，区间在句内、不重叠、不越源时长；核对对齐信息中的完整时长和总帧数。
5. 核对明显同音字、姓名和专业词，修改时同步 SRT、JSON 正文与词元。仅改文字时保持时间和帧数。无法从原音频或用户文案确定的词不要编造。
6. 交付三份文件的绝对路径，简要说明源时长与帧率。有影响使用的异常简短告知；无需额外生成过程复盘。

## 中文主题命名

三份交付文件统一使用当期文案的中文主题作为前缀：

- `{当期中文主题}_自动时间码字幕.srt`
- `{当期中文主题}_自动动效时间轴.json`
- `{当期中文主题}_视频对齐信息.json`

优先采用用户当期确认的标题或期名；没有标题时，从提供的文案概括清楚、简洁的中文主题。调用程序时主动传入该主题，不沿用英文媒体名、随机编号、哈希或纯日期作为最终文件名。例如“2027年买新房还是二手房”。

只有媒体且无法提前确定主题时，先在系统临时目录以“本期文案”为临时名称完成识别，读取字幕正文后确定中文主题，再将三份文件统一重命名并归档到用户当前项目 `outputs/字幕文件/`（没有项目目录时，使用输入文件旁的 `字幕文件/`），清理临时产物。不得把临时名称作为最终交付，也不要求用户额外手动命名。

输入文件名本身就是当期中文主题时，可以省略主题参数；否则必须传入中文主题。三份交付文件前缀一致，同一期修改继续更新同名文件。

## 下游视频必须遵守

- 完整视频长度取 `视频对齐信息.json` 的 `composition.fps` 与 `composition.durationInFrames`。字幕末尾不等于视频结尾；不得拉长字幕来凑总时长。
- 所有时间以原文件播放起点为零。字幕、动效直接放到绝对起止位置，保留开头、句间、尾部静音与原时间戳间隙。不能把各段时长相加后连续拼接。
- 独立片段的所有时间统一减去同一个已确认片段起点。结束帧为不包含该帧的边界。各段绝对帧分别取整，不累计取整后的段时长。
- 关键词用 `tokens.startMs` 或 `tokens.startFrame`；`timestampMs` 只是单个对齐点。不要按字数均分时间。
- 当前 Whisper.cpp DTW 网格为 20ms，自动词元仍是估计。正式使用前核对原视频开头、中间、结尾及 `alignment.review` 标记；没有听音或人工参照时，不声称逐帧准确或音画同步已验收。
- 可变帧率源按播放时间对应固定帧率目标，不保证源视频逐帧一一对应；输出帧率必须与实际制作工程一致。

## 实现与检查

`pipeline.mjs` 保留完整时间线，以静音为可选切点进行短段识别，再还原绝对时间；`media-clock.mjs` 负责源视频时钟和帧率，`alignment.mjs` 还原完整中文词元并估计边界，`delivery.mjs` 输出兼容数组。

输入只读，模型只引用已有路径。临时 WAV、原始识别 JSON 与日志在系统临时目录内创建并自动清理。程序、模型、运行包和用户媒体不纳入公开仓库。

改动后运行 `node --test "<Skill目录>/scripts/alignment.test.mjs" "<Skill目录>/scripts/media-clock.test.mjs"`，并用真实媒体验证。安装说明、配置参数与时间线字段见 [README.md](README.md)。
