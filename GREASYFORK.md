![CoserOps X(推特) 翻译 Logo](https://raw.githubusercontent.com/coserops/coserops-x-translator/fa5d9749ac3372bca3c6e954343e5af16367570c/logo.png)

# CoserOps X(推特) 翻译

**看外语推文，读评论讨论，不用来回复制、切换页面。**

在 Grok 按钮左侧点一下「译」，就在右侧对照原文与译文。使用自己的 API Key 和模型，让翻译跟上阅读，而不是打断阅读。

## 从刷推到回复，少一点语言阻碍

- **想看哪条，就翻哪条**：支持 For you / Following 时间流、个人主页、帖子详情和评论区，按需翻译文字。
- **边读讨论，边对照原文**：译文在右侧展开，不离开当前页面，方便理解上下文、整理自己的回复。
- **回头查看，少一次重复调用**：再次点击时优先读取匹配缓存。默认最多保留最近使用的 20 条，可调整至 100 条；想重新翻译也有入口。
- **语言不用再选一遍**：译文自动跟随浏览器首选语言，区分中文简繁体；较有把握识别到同语言时跳过请求，也可手动强制翻译。
- **模型和服务商，由你决定**：支持 DeepSeek、Qwen、Google Gemini、OpenAI GPT、xAI Grok，以及可信的 OpenAI 兼容中转站，无需部署服务器。

## 三步开始

1. 安装 **Tampermonkey（篡改猴）**，将下方脚本文件的完整内容复制到新建脚本中，保存。
2. 打开 X，在篡改猴菜单选择 **「X 翻译：设置 API Key / 模型」**；先确认服务商、地址和模型，再填写自己的 Key 并保存。
3. 点击推文或评论旁的 **「译」**，查看结果。

需自备可用的 API Key，调用可能计费；模型可用性和费用以服务商为准。命中缓存或本地同语言跳过时，不发送新的翻译请求。

## 使用前了解

支持 `x.com`、`twitter.com`。按钮依赖可识别的 Grok 按钮；首页标签目前识别中文、英文，网站改版可能影响显示。搜索页暂不支持，不翻译图片、视频或引用正文。译文供理解参考，重要内容请结合原文确认。

请求时，原文和 Key 直接发送给所选服务商或中转站，请确认其可信。Key 及缓存原文、译文非加密保存在篡改猴本地存储；缓存可关闭、清空。

## 下载与源码

- **脚本文件**：[x-translator.user.js](https://github.com/coserops/coserops-x-translator/blob/main/x-translator.user.js)
- **配置指南与项目源码**：[CoserOps X(推特) 翻译](https://github.com/coserops/coserops-x-translator)

## 更多项目

[发现更多 CoserOps 实用脚本](https://github.com/orgs/coserops/repositories)
