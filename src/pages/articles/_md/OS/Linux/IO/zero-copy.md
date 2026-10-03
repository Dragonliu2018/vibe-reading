---
title: "零拷贝技术"
date: "2026-10-03T10:35:00+08:00"
category: [OS, Linux, Notes, "I/O"]
contentType: "Notes"
source:
  project: "Notion"
  type: "Article"
  url: "https://app.notion.com/p/dragonliu/17da55ded5644f1a8e6d231e2397fc01"
tags: [操作系统, Linux, I/O, 零拷贝, DMA, mmap, sendfile, splice]
description: "介绍传统文件传输中的数据拷贝与状态切换，以及 mmap、sendfile、DMA 收集和 splice 等零拷贝实现方式。"
readingTime: "12 min"
reviewed: false
---

> Linux系统中一切皆文件，仔细想一下Linux系统的很多活动无外乎**读操作**和**写操作**，**零拷贝就是为了提高读写性能而出现的**。

## 数据拷贝基础过程

在Linux系统内部缓存和内存容量都是有限的，更多的数据都是存储在磁盘中。对于Web服务器来说，经常需要从磁盘中读取数据到内存，然后再通过网卡传输给用户：

![磁盘数据经过内存传输到网卡](/vibe-reading/images/articles/zero-copy/zero-copy-data-flow.png)

上述数据流转只是大框，接下来看看几种模式。

### 仅CPU方式

- 当应用程序需要读取磁盘数据时，调用read()从用户态陷入内核态，read()这个[系统调用](https://zhida.zhihu.com/search?q=%E7%B3%BB%E7%BB%9F%E8%B0%83%E7%94%A8&zhida_source=entity&is_preview=1)最终由CPU来完成；
- CPU向磁盘发起I/O请求，磁盘收到之后开始准备数据；
- 磁盘将数据放到[磁盘缓冲区](https://zhida.zhihu.com/search?q=%E7%A3%81%E7%9B%98%E7%BC%93%E5%86%B2%E5%8C%BA&zhida_source=entity&is_preview=1)之后，向CPU发起I/O中断，报告CPU数据已经Ready了；
- CPU收到磁盘控制器的I/O中断之后，开始拷贝数据，完成之后read()返回，再从内核态切换到用户态；

![仅CPU方式的数据读取过程](/vibe-reading/images/articles/zero-copy/zero-copy-cpu-only.png)

### CPU & DMA方式

CPU的时间宝贵，让它做杂活就是浪费资源。

[直接内存访问](https://zhida.zhihu.com/search?q=%E7%9B%B4%E6%8E%A5%E5%86%85%E5%AD%98%E8%AE%BF%E9%97%AE&zhida_source=entity&is_preview=1)（Direct Memory Access），是一种硬件设备绕开CPU独立直接访问内存的机制。所以DMA在一定程度上解放了CPU，把之前CPU的杂活让硬件直接自己做了，提高了CPU效率。

目前支持DMA的硬件包括：网卡、声卡、显卡、磁盘控制器等。

![支持DMA的硬件](/vibe-reading/images/articles/zero-copy/zero-copy-dma-hardware.png)

有了DMA的参与之后的流程发生了一些变化：

![CPU与DMA方式的数据读取过程](/vibe-reading/images/articles/zero-copy/zero-copy-dma-flow.png)

最主要的变化是，CPU不再和磁盘直接交互，而是DMA和磁盘交互并且将数据从磁盘缓冲区拷贝到内核缓冲区，之后的过程类似。

> **无论从仅CPU方式和DMA&CPU方式，都存在多次冗余数据拷贝和内核态&用户态的切换。**

## 普通模式数据交互

我们继续思考Web服务器读取本地磁盘文件数据再通过网络传输给用户的详细过程。

一次完成的数据交互包括几个部分：系统调用syscall、CPU、DMA、网卡、磁盘等。

![普通模式数据交互的组成部分](/vibe-reading/images/articles/zero-copy/zero-copy-components.png)

系统调用syscall是应用程序和内核交互的桥梁，每次进行调用/返回就会产生两次切换：

- 调用syscall 从用户态切换到内核态
- syscall返回 从内核态切换到用户态

![系统调用引起的状态切换](/vibe-reading/images/articles/zero-copy/zero-copy-syscall-switch.png)

来看下完整的数据拷贝过程简图：

![普通模式下完整的数据拷贝过程](/vibe-reading/images/articles/zero-copy/zero-copy-traditional-flow.png)

读数据过程：

- 应用程序要读取磁盘数据，调用read()函数从而实现用户态切换内核态，这是第1次状态切换；
- DMA控制器将数据从磁盘拷贝到内核缓冲区，这是第1次DMA拷贝；
- CPU将数据从内核缓冲区复制到用户缓冲区，这是第1次CPU拷贝；
- CPU完成拷贝之后，read()函数返回实现用户态[切换用户](https://zhida.zhihu.com/search?q=%E5%88%87%E6%8D%A2%E7%94%A8%E6%88%B7&zhida_source=entity&is_preview=1)态，这是第2次状态切换；

写数据过程：

- 应用程序要向网卡写数据，调用write()函数实现用户态切换内核态，这是第1次切换；
- CPU将用户缓冲区数据拷贝到内核缓冲区，这是第1次CPU拷贝；
- DMA控制器将数据从内核缓冲区复制到socket缓冲区，这是第1次DMA拷贝；
- 完成拷贝之后，write()函数返回实现内核态切换用户态，这是第2次切换；

综上所述：

- 读过程涉及2次空间(状态)切换、1次DMA拷贝、1次CPU拷贝；
- 写过程涉及2次空间(状态)切换、1次DMA拷贝、1次CPU拷贝；

可见传统模式下，涉及多次空间切换和数据冗余拷贝，效率并不高，接下来就该零拷贝技术出场了。

## 零拷贝技术

### 出现原因

我们可以看到，**如果应用程序不对数据做修改，从内核缓冲区到用户缓冲区，再从用户缓冲区到内核缓冲区。两次数据拷贝都需要CPU的参与，并且涉及用户态与内核态的多次切换，加重了CPU负担。**

我们需要**降低冗余数据拷贝、解放CPU**，这也就是零拷贝Zero-Copy技术。

### 解决思路

目前来看，零拷贝技术的几个实现手段包括：mmap+write、sendfile、sendfile+DMA收集、splice等。

![零拷贝技术的实现方式](/vibe-reading/images/articles/zero-copy/zero-copy-methods.png)

#### 1 mmap方式

**mmap（memory map）是Linux提供的一种[内存映射文件](https://zhida.zhihu.com/search?q=%E5%86%85%E5%AD%98%E6%98%A0%E5%B0%84%E6%96%87%E4%BB%B6&zhida_source=entity&is_preview=1)的机制，它实现了将内核中读缓冲区地址与用户[空间缓冲区](https://zhida.zhihu.com/search?q=%E7%A9%BA%E9%97%B4%E7%BC%93%E5%86%B2%E5%8C%BA&zhida_source=entity&is_preview=1)地址进行映射，从而实现内核缓冲区与用户缓冲区的共享。**

这样就减少了一次用户态和内核态的CPU拷贝，但是在内核空间内仍然有一次CPU拷贝。

mmap对大文件传输有一定优势，但是小文件可能出现碎片，并且在多个进程同时操作文件时可能产生引发coredump的signal。

![mmap方式的数据拷贝过程](/vibe-reading/images/articles/zero-copy/zero-copy-mmap.png)

#### 2 sendfile方式

mmap+write方式有一定改进，但是由系统调用引起的状态切换并没有减少。

sendfile系统调用是在 Linux 内核2.1版本中被引入，它建立了两个文件之间的传输通道。

sendfile方式只使用一个函数就可以完成之前的read+write 和 mmap+write的功能，这样就少了2次状态切换，由于数据不经过用户缓冲区，因此该数据无法被修改。

![sendfile方式概览](/vibe-reading/images/articles/zero-copy/zero-copy-sendfile-overview.png)

![sendfile方式的数据拷贝过程](/vibe-reading/images/articles/zero-copy/zero-copy-sendfile-flow.png)

从图中可以看到，应用程序只需要调用sendfile函数即可完成，只有2次状态切换、1次CPU拷贝、2次DMA拷贝。

但是sendfile在内核缓冲区和socket缓冲区仍然存在一次CPU拷贝，或许这个还可以优化。

#### 3 sendfile+DMA收集

Linux 2.4 内核对 sendfile 系统调用进行优化，但是需要硬件DMA控制器的配合。

升级后的sendfile将内核空间缓冲区中对应的数据描述信息（[文件描述符](https://zhida.zhihu.com/search?q=%E6%96%87%E4%BB%B6%E6%8F%8F%E8%BF%B0%E7%AC%A6&zhida_source=entity&is_preview=1)、地址偏移量等信息）记录到socket缓冲区中。

DMA控制器根据socket缓冲区中的地址和偏移量将数据从内核缓冲区拷贝到网卡中，从而省去了内核空间中仅剩1次CPU拷贝。

![sendfile与DMA收集的数据拷贝过程](/vibe-reading/images/articles/zero-copy/zero-copy-sendfile-dma.png)

这种方式有2次状态切换、0次CPU拷贝、2次DMA拷贝，但是仍然无法对数据进行修改，并且需要硬件层面DMA的支持，并且sendfile只能将文件数据拷贝到socket描述符上，有一定的局限性。

#### 4 splice方式

splice系统调用是Linux 在 2.6 版本引入的，其不需要硬件支持，并且不再限定于socket上，实现两个普通文件之间的数据零拷贝。

![splice方式的数据拷贝过程](/vibe-reading/images/articles/zero-copy/zero-copy-splice.png)

splice也有一些局限，它的两个文件描述符参数中有一个必须是管道设备。

## X 参考

- [https://zhuanlan.zhihu.com/p/360343446](https://zhuanlan.zhihu.com/p/360343446)
