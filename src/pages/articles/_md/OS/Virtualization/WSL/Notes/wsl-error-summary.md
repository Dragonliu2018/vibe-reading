---
title: "wsl 报错汇总"
date: "2026-08-23T17:13:24+08:00"
category: [OS, Virtualization, WSL, Notes]
alsoCategories:
  - [Tools, Notes]
tags: ["wsl", "systemd", "报错", "故障排查", "技巧"]
description: "wsl 常见报错速查——systemctl 执行失败（systemd 未作为 init 启动）的原因与解决。"
readingTime: "1 min"
aiModel: "Claude Opus 5"
reviewed: false
---

## 执行 systemctl 失败

【问题】

```text title="systemctl 报错信息"
System has not been booted with systemd as init system (PID 1). Can't operate. Failed to connect to bus: Host is down
```

---

【解决】

[https://github.com/microsoft/WSL/issues/8883](https://github.com/microsoft/WSL/issues/8883)
