明白了：**纯本地、无后端、只用 Gemini、功能精简**。下面给你一份更贴合的功能文档（含关键代码骨架），用**浏览器 + File System Access API** 实现“粘贴即保存到本地指定文件夹”，并可选用 **Gemini 生图**（前端直连，用户手动输入 API Key；仅本机使用）。

---

# 轻量版功能文档（无后端 / 仅本地）

## 1. 目标与范围

* 在浏览器页面里：

  1. 有一个**输入框**（当作描述/Prompt）。
  2. 用户**粘贴图片**（Ctrl/⌘+V）或**拖拽图片**进页面，自动**保存到本地选定文件夹**。
  3. 展示缩略图与本地文件名，支持**复制 Markdown/HTML** 引用。
  4. （可选）点击按钮用当前 Prompt 调 Gemini **直接生成图片**，并同样**保存到本地**。
* **无后端服务器**：仅浏览器+本地文件系统能力。
* **Key 管理**：页面提供“输入 GEMINI_API_KEY”对话框（只保存在内存，会随刷新丢失；更安全）。

> 说明：浏览器直接调用 Gemini 会暴露 API Key 给本机页面（适用于你个人本机调试/使用，不适合发布给公众）。

---

## 2. 功能清单（精简）

* **选择保存目录**：首次使用点“选择保存文件夹”，通过 **File System Access API**（Chromium 内核）授权目录句柄并持久化到 `localStorage`（仅存句柄的权限索引，具体实现见下面示例）。
* **粘贴/拖拽**图片自动保存：

  * 校验 `image/*` 类型与大小（默认 10MB）。
  * 自动生成文件名：`img_<时间戳>_<序号>.png/jpg/webp`。
  * 保存完成后在页面网格中显示缩略图与名称。
* **引用复制**：

  * 复制 **Markdown**：`![](./相对路径)`
  * 复制 **HTML**：`<img src="./相对路径" alt="...">`
* **Gemini 生图（可选）**：

  * 手动输入 `GEMINI_API_KEY`（内存保存，不落盘）。
  * 点击“生成图片”用当前 Prompt 调 `@google/genai` 的 `generateContentStream`，收到 `inlineData` 后**写入同一目录**。
  * 失败给出 Toast/提示。
* **图库**：只展示**本次会话**新增的图片（不做全盘扫描，保持轻量）。

---

## 3. 技术与限制

* 前端：Vite + TypeScript + 原生 Web API（不需要 React 也可跑；你喜欢也可加 React）。
* 依赖：

  ```bash
  npm i @google/genai mime
  npm i -D typescript vite @types/node
  ```
* 浏览器要求：**Chromium**（Chrome/Edge 92+）支持 File System Access API。
* 安全：Key 仅存在内存变量；如需更安全，可做**本地 Electron**（主进程持有 Key，不暴露给渲染页）。

---

## 4. 交互流程（核心）

1. **首次**点击「选择保存文件夹」→ `showDirectoryPicker()` → 记录目录句柄。
2. **粘贴/拖拽**图片 → 生成文件名 → `dirHandle.getFileHandle(name, {create:true})` → `createWritable()` → `write(bytes)` → `close()`。
3. UI 新增卡片（缩略图用 `URL.createObjectURL(new Blob([bytes], {type})`）。
4. **可选**「生成图片」→ 传入 prompt + key → 从 Gemini 流式拿到 `inlineData` → 同样落盘。

---

## 5. 关键代码骨架（可直接放到 Vite 项目 `index.html`/`main.ts`）

### 5.1 HTML（`index.html` 简化示例）

```html
<!doctype html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>本地粘贴图 & Gemini 生图（无后端）</title>
  <style>
    body { font: 14px/1.6 system-ui, sans-serif; padding: 16px; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill,minmax(160px,1fr)); gap:10px; margin-top:12px; }
    .card { border:1px solid #ddd; border-radius:10px; padding:10px; }
    .dropzone { border:2px dashed #999; padding:24px; border-radius:12px; text-align:center; color:#666; }
    .dropzone.dragover { border-color:#3b82f6; color:#3b82f6; background:#f0f7ff; }
    .thumb { width:100%; height:120px; object-fit:cover; border-radius:8px; }
    .muted { color:#666; font-size:12px; }
    button { padding:6px 10px; }
    input, textarea { padding:6px 8px; width:100%; }
  </style>
</head>
<body>
  <div class="row">
    <button id="pickDirBtn">选择保存文件夹</button>
    <button id="setKeyBtn">设置 GEMINI_API_KEY</button>
    <span id="dirStatus" class="muted"></span>
  </div>

  <div style="margin-top:12px;">
    <label>描述 / Prompt</label>
    <textarea id="prompt" rows="3" placeholder="在这里写你的描述..."></textarea>
    <div class="row" style="margin-top:8px;">
      <button id="genBtn">用 Gemini 生成图片（可选）</button>
      <span id="keyStatus" class="muted"></span>
    </div>
  </div>

  <div id="dropzone" class="dropzone" style="margin-top:16px;">
    粘贴图片（Ctrl/⌘+V）或拖拽图片到这里
  </div>

  <div class="grid" id="gallery"></div>

  <script type="module" src="/main.ts"></script>
</body>
</html>
```

### 5.2 TS（`main.ts`）

```ts
import { GoogleGenerativeAI as GoogleGenAI } from '@google/genai';
import mime from 'mime';

type SavedItem = {
  name: string;
  mime: string;
  size: number;
  objectUrl: string;
  path?: string; // 可显示相对名
};

let dirHandle: FileSystemDirectoryHandle | null = null;
let apiKey: string | null = null;
const gallery = document.getElementById('gallery')!;
const dropzone = document.getElementById('dropzone')!;
const dirStatus = document.getElementById('dirStatus')!;
const keyStatus = document.getElementById('keyStatus')!;
const promptEl = document.getElementById('prompt') as HTMLTextAreaElement;

document.getElementById('pickDirBtn')!.addEventListener('click', pickDir);
document.getElementById('setKeyBtn')!.addEventListener('click', setKey);
document.getElementById('genBtn')!.addEventListener('click', generateWithGemini);

// 粘贴监听
window.addEventListener('paste', async (e: ClipboardEvent) => {
  const items = e.clipboardData?.items || [];
  const files: File[] = [];
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    await handleFiles(files);
  }
});

// 拖拽
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
  if (files.length) await handleFiles(files);
});

async function pickDir() {
  try {
    // 让用户选择保存目录
    // @ts-ignore
    dirHandle = await (window as any).showDirectoryPicker();
    dirStatus.textContent = '已选择保存目录';
  } catch (e) {
    console.warn('取消选择目录或不支持：', e);
  }
}

async function ensureDir() {
  if (!dirHandle) {
    alert('请先点击“选择保存文件夹”授权目录。');
    throw new Error('No directory selected');
  }
}

async function handleFiles(files: File[]) {
  await ensureDir();
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      toast('仅支持图片类型');
      continue;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast('单张图片大小上限 10MB');
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = guessExt(file.type);
    const name = makeName(ext);
    await writeFileToDir(name, bytes);
    addCard({ name, mime: file.type, size: file.size, objectUrl: URL.createObjectURL(file), path: name });
  }
}

function makeName(ext: string) {
  const t = new Date();
  const stamp = `${t.getFullYear()}${String(t.getMonth()+1).padStart(2,'0')}${String(t.getDate()).padStart(2,'0')}_${String(t.getHours()).padStart(2,'0')}${String(t.getMinutes()).padStart(2,'0')}${String(t.getSeconds()).padStart(2,'0')}`;
  const rand = Math.random().toString(36).slice(2,6);
  return `img_${stamp}_${rand}${ext}`;
}

function guessExt(mimeType: string) {
  const ext = mime.getExtension(mimeType);
  return ext ? `.${ext}` : (mimeType.includes('png') ? '.png' : '.bin');
}

async function writeFileToDir(name: string, data: Uint8Array) {
  // @ts-ignore
  const fileHandle: FileSystemFileHandle = await dirHandle!.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

function addCard(item: SavedItem) {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `
    <img class="thumb" src="${item.objectUrl}" alt="${item.name}">
    <div class="muted" style="margin-top:6px;">${item.name}</div>
    <div class="row" style="margin-top:6px;">
      <button class="btn-md">复制 Markdown</button>
      <button class="btn-html">复制 HTML</button>
    </div>
  `;
  div.querySelector('.btn-md')!.addEventListener('click', () => {
    // 假设你的笔记/项目会以相对路径引用
    const md = `![](${encodeURI('./' + (item.path || item.name))})`;
    copy(md);
  });
  div.querySelector('.btn-html')!.addEventListener('click', () => {
    const html = `<img src="${encodeURI('./' + (item.path || item.name))}" alt="${item.name}">`;
    copy(html);
  });
  gallery.prepend(div);
}

function toast(msg: string) {
  console.log(msg);
  // 简化处理；你也可以加个浮层
  alert(msg);
}

function copy(text: string) {
  navigator.clipboard.writeText(text).then(() => {
    toast('已复制到剪贴板');
  }).catch(() => {
    toast('复制失败');
  });
}

async function setKey() {
  const k = prompt('输入 GEMINI_API_KEY（仅当前会话内存保存）');
  if (k && k.trim()) {
    apiKey = k.trim();
    keyStatus.textContent = 'Key 已设置（内存）';
  } else {
    apiKey = null;
    keyStatus.textContent = '未设置 Key';
  }
}

async function generateWithGemini() {
  if (!apiKey) { toast('请先设置 GEMINI_API_KEY'); return; }
  await ensureDir();
  const prompt = promptEl.value.trim();
  if (!prompt) { toast('请先填写 Prompt'); return; }

  const ai = new (GoogleGenAI as any)({ apiKey });
  const model = 'gemini-2.5-flash-image';
  const config = { responseModalities: ['IMAGE', 'TEXT'] };
  let saved = 0;

  try {
    const stream = await ai.models.generateContentStream({
      model, config,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    for await (const chunk of stream) {
      const c = chunk?.candidates?.[0];
      const part = c?.content?.parts?.[0];
      if (!part) continue;

      // 文本增量（可在 UI 上显示）
      if (part.text) console.log(part.text);

      const inline = part.inlineData;
      if (inline?.data) {
        const bytes = base64ToBytes(inline.data);
        const ext = guessExt(inline.mimeType || 'image/png');
        const name = makeName(ext);
        await writeFileToDir(name, bytes);
        addCard({
          name,
          mime: inline.mimeType || 'image/png',
          size: bytes.byteLength,
          objectUrl: URL.createObjectURL(new Blob([bytes], { type: inline.mimeType || 'image/png' })),
          path: name,
        });
        saved++;
      }
    }

    if (!saved) toast('未接收到图片数据（可能被策略拒绝或仅返回文本）。');
  } catch (err: any) {
    console.error(err);
    toast('生成失败：' + (err?.message || '未知错误'));
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
```

---

## 6. 使用方式

```bash
# 1) 初始化
npm init -y
npm i @google/genai mime
npm i -D vite typescript @types/node

# 2) 新建 index.html / main.ts 如上

# 3) 启动
npx vite
# 打开 http://localhost:5173
```

* 进入页面后先点击「**选择保存文件夹**」，再点「**设置 GEMINI_API_KEY**」输入你的 Key，然后输入 Prompt，点「**用 Gemini 生成图片**」即可。
* 直接**粘贴/拖拽**图片也会自动保存到刚才选的目录。

---

## 7. 已知限制 & 建议

* **Key 暴露**：仅适合你个人本机使用；若需分享给他人使用，建议改为 **Electron**（主进程持 Key），仍然无“后端服务器”。
* **浏览器支持**：File System Access API 需 Chromium；Safari/Firefox 可 fallback 为“下载保存”对话框（不自动写入目录）。
* **历史图库**：本方案只展示“本次会话新增文件”；若要显示目录内所有图片，可增加 `for await (const entry of dirHandle.values())` 遍历并生成 `objectURL`（注意大目录性能）。

---

如果你需要，我可以把上面的骨架直接打包成一个**最小 Vite 项目模板**（含文件结构），你拷贝即跑。也可以给一个**Electron 版本**（更安全持 Key、不暴露到网页上下文）。
