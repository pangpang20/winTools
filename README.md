# 桌面工具箱

基于 Electron 的 Windows 11 桌面工具箱，包含计时、专注、便签、剪贴板、截图、转换、提醒、二维码、文本朗读和窗口置顶工具。

## 本地运行

```bash
npm install
npm start
```

## 构建 Windows 安装包

在 Windows 环境执行：

```bash
npm run dist
```

也可以直接双击项目根目录的 `build-windows.bat`。脚本会自动使用华为云镜像下载 Electron 和 npm 依赖，再生成 `release/win-unpacked/桌面工具箱.exe` 免安装版本。

需要 NSIS 安装器时，执行 `npm run dist`。

## 功能

- 秒表与倒计时模式
- 置顶显示、透明度、字号和颜色设置
- 番茄钟专注与休息周期
- 快速便签自动保存，每条便签可独立弹出
- 默认开启的剪贴板历史
- 屏幕截图与颜色格式复制
- 长度、重量、温度、时间戳和文件大小转换
- Windows 桌面提醒通知
- 文本生成二维码
- TXT / DOCX 文件本地提取并使用系统语音朗读
- 自定义全局快捷键
- 枚举可见 Windows 窗口并切换窗口置顶
