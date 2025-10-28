import { GoogleGenAI } from '@google/genai';

const pickDirBtn = document.getElementById('pickDirBtn') as HTMLButtonElement;
const dirStatusEl = document.getElementById('dirStatus') as HTMLSpanElement;
const keyBtn = document.getElementById('keyBtn') as HTMLButtonElement;
const keyStatusEl = document.getElementById('keyStatus') as HTMLSpanElement;
const dropZone = document.getElementById('dropZone') as HTMLElement;
const attachToggle = document.getElementById('attachToggle') as HTMLInputElement;
const promptInput = document.getElementById('promptInput') as HTMLTextAreaElement;
const generateBtn = document.getElementById('genBtn') as HTMLButtonElement;
const gallery = document.getElementById('gallery') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLDivElement;

const FILE_SIZE_LIMIT = 10 * 1024 * 1024;
const DB_NAME = 'gemini-helper';
const STORE_NAME = 'handles';
const DIR_HANDLE_KEY = 'dir-handle';
const MAX_INITIAL_FILES = 60;
const MAX_CONTEXT_ASSETS = 6;

let dirHandle: FileSystemDirectoryHandle | null = null;
let apiKey: string | null = null;
let generating = false;
let toastTimer: number | undefined;
const objectUrls = new Set<string>();
const contextAssets = new Map<string, ContextAsset>();
let attachImagesToPrompt = false;

const supportsFileSystemAccess = 'showDirectoryPicker' in window;

if (attachToggle) {
  attachImagesToPrompt = attachToggle.checked;
}

if (!supportsFileSystemAccess) {
  pickDirBtn.disabled = true;
  dropZone.classList.add('disabled');
  dropZone.innerHTML =
    '<p>Your browser does not support the File System Access API. Please try Chromium 92+.</p>';
  showToast('File System Access API unavailable; features disabled');
}

pickDirBtn.addEventListener('click', async () => {
  await pickDirectory();
});

keyBtn.addEventListener('click', () => {
  setApiKey();
});

generateBtn.addEventListener('click', async () => {
  await generateWithGemini();
});

attachToggle?.addEventListener('change', () => {
  attachImagesToPrompt = attachToggle.checked;
  showToast(
    attachImagesToPrompt
      ? 'Pasted images will be attached to Gemini prompts'
      : 'Gemini prompts will include text only',
  );
});

dropZone.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const files = Array.from(event.dataTransfer?.files ?? []);
  await handleIncomingFiles(files);
});

document.addEventListener('paste', async (event) => {
  const items = Array.from(event.clipboardData?.files ?? []);
  if (!items.length) {
    return;
  }
  await handleIncomingFiles(items);
});

void restoreDirectory();

interface CardPayload {
  name: string;
  size: number;
  mime: string;
  objectUrl: string;
  path: string;
}

interface ContextAsset {
  name: string;
  mime: string;
  getBytes: () => Promise<Uint8Array>;
}

async function handleIncomingFiles(files: File[]) {
  if (!files.length) {
    showToast('No image files detected');
    return;
  }

  const images = files.filter((file) => file.type.startsWith('image/'));
  if (!images.length) {
    showToast('Only image/* files are supported');
    return;
  }

  const targetDir = await ensureDirectory();
  if (!targetDir) {
    return;
  }

  for (const file of images) {
    if (file.size > FILE_SIZE_LIMIT) {
      showToast(`${file.name} exceeds the 10MB limit and was skipped`);
      continue;
    }
    try {
      await saveFileFromBlob(file);
    } catch (error) {
      console.error(error);
      showToast(`Failed to save ${file.name}`);
    }
  }
}

async function saveFileFromBlob(file: File) {
  const ext = inferExtension(file);
  const name = makeFileName(ext);
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFileToDir(name, bytes);
  const blob = new Blob([bytes], { type: file.type || 'image/png' });
  addCard({
    name,
    size: blob.size,
    mime: blob.type,
    objectUrl: URL.createObjectURL(blob),
    path: name,
  });
  showToast(`Saved ${name}`);
  rememberContextAsset(name, blob.type, async () => bytes.slice());
}

async function pickDirectory() {
  if (!supportsFileSystemAccess) {
    return;
  }

  try {
    const handle = await window.showDirectoryPicker();
    const granted = await verifyPermission(handle);
    if (!granted) {
      showToast('Read/write permission is required to store images');
      return;
    }
    dirHandle = handle;
    await persistDirectoryHandle(handle);
    updateDirStatus();
    await loadExistingImages();
    showToast(`Directory ready: ${handle.name}`);
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') {
      return;
    }
    console.error(error);
    showToast('Folder selection failed');
  }
}

async function ensureDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (dirHandle) {
    return dirHandle;
  }
  showToast('Choose a directory before saving images');
  return null;
}

async function writeFileToDir(name: string, bytes: Uint8Array): Promise<FileSystemFileHandle> {
  if (!dirHandle) {
    throw new Error('Directory not selected');
  }
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return fileHandle;
}

async function restoreDirectory() {
  if (!supportsFileSystemAccess) {
    updateDirStatus();
    return;
  }
  try {
    const stored = await loadPersistedDirectoryHandle();
    if (!stored) {
      updateDirStatus();
      return;
    }
    const granted = await verifyPermission(stored);
    if (!granted) {
      await removePersistedDirectoryHandle();
      updateDirStatus();
      return;
    }
    dirHandle = stored;
    updateDirStatus();
    await loadExistingImages();
  } catch (error) {
    console.error(error);
    updateDirStatus();
  }
}

async function verifyPermission(handle: FileSystemDirectoryHandle) {
  const status = await handle.queryPermission({ mode: 'readwrite' });
  if (status === 'granted') {
    return true;
  }
  if (status === 'denied') {
    return false;
  }
  const requested = await handle.requestPermission({ mode: 'readwrite' });
  return requested === 'granted';
}

async function loadExistingImages() {
  revokeObjectUrls();
  gallery.innerHTML = '';
  if (!dirHandle) {
    return;
  }

  try {
    let loaded = 0;
    for await (const entry of dirHandle.values()) {
      if (entry.kind !== 'file') {
        continue;
      }
      const file = await entry.getFile();
      if (!file.type.startsWith('image/')) {
        continue;
      }
      const mime = file.type || inferMimeFromName(entry.name);
      const objectUrl = URL.createObjectURL(file);
      addCard({
        name: entry.name,
        size: file.size,
        mime,
        objectUrl,
        path: entry.name,
      });
      rememberContextAsset(entry.name, mime, async () => {
        const latest = await entry.getFile();
        return new Uint8Array(await latest.arrayBuffer());
      });
      loaded += 1;
      if (loaded >= MAX_INITIAL_FILES) {
        break;
      }
    }
    if (!loaded) {
      gallery.innerHTML = '<p>No images found in this directory.</p>';
    }
  } catch (error) {
    console.error(error);
    showToast('Failed to read from the directory');
  }
}

function addCard(payload: CardPayload) {
  objectUrls.add(payload.objectUrl);
  const card = document.createElement('article');
  card.className = 'card';

  const img = document.createElement('img');
  img.src = payload.objectUrl;
  img.alt = payload.name;
  card.append(img);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `
    <strong>${escapeHtml(payload.name)}</strong>
    <span>${payload.mime} | ${formatBytes(payload.size)}</span>
  `;

  const actions = document.createElement('div');
  actions.className = 'row';

  const mdBtn = document.createElement('button');
  mdBtn.textContent = 'Copy Markdown';
  mdBtn.addEventListener('click', () => {
    const md = `![](${encodeURI(`./${payload.path}`)})`;
    void copyToClipboard(md);
  });

  const htmlBtn = document.createElement('button');
  htmlBtn.textContent = 'Copy HTML';
  htmlBtn.addEventListener('click', () => {
    const html = `<img src="${encodeURI(`./${payload.path}`)}" alt="${escapeHtml(
      payload.name,
    )}">`;
    void copyToClipboard(html);
  });

  actions.append(mdBtn, htmlBtn);
  meta.append(actions);
  card.append(meta);

  gallery.prepend(card);
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } catch (error) {
    console.error(error);
    showToast('Copy failed');
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferExtension(file: File) {
  if (file.name.includes('.')) {
    return file.name.split('.').pop() ?? 'png';
  }
  return guessExtension(file.type);
}

function guessExtension(mime: string) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'png';
}

function makeFileName(ext: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = Math.random().toString(36).slice(2, 8);
  return `img_${stamp}_${random}.${ext}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)}GB`;
}

function updateDirStatus() {
  if (!dirHandle) {
    dirStatusEl.textContent = 'No directory selected';
    return;
  }
  dirStatusEl.textContent = `Ready: ${dirHandle.name}`;
}

function setApiKey() {
  const input = window.prompt('Enter GEMINI_API_KEY (kept in memory only)', apiKey ?? '');
  if (!input) {
    apiKey = null;
    keyStatusEl.textContent = 'API key not set (memory only)';
    showToast('Key cleared');
    return;
  }
  apiKey = input.trim();
  if (!apiKey) {
    keyStatusEl.textContent = 'API key not set (memory only)';
    showToast('Key is empty and was cleared');
    return;
  }
  keyStatusEl.textContent = 'Key ready (memory only)';
  showToast('Key stored in memory');
}

async function generateWithGemini() {
  if (generating) {
    return;
  }
  if (!apiKey) {
    showToast('Set GEMINI_API_KEY before generating images');
    return;
  }
  const handle = await ensureDirectory();
  if (!handle) {
    return;
  }
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showToast('Prompt cannot be empty');
    return;
  }

  generating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Generating...';

  try {
    const client = new GoogleGenAI({ apiKey });
    let saved = 0;
    const parts = await buildPromptParts(prompt);
    const stream = await client.models.generateContentStream({
      model: 'gemini-2.5-flash-image',
      config: { responseModalities: ['IMAGE', 'TEXT'] },
      contents: [{ role: 'user', parts }],
    });

    for await (const chunk of stream) {
      const candidate = chunk?.candidates?.[0];
      const part = candidate?.content?.parts?.find((item) => item.inlineData);
      if (!part?.inlineData?.data) {
        if (part?.text) {
          console.log(part.text);
        }
        continue;
      }
      const mime = part.inlineData.mimeType ?? 'image/png';
      const bytes = base64ToBytes(part.inlineData.data);
      const ext = guessExtension(mime);
      const name = makeFileName(ext);
      await writeFileToDir(name, bytes);
      const blob = new Blob([bytes], { type: mime });
      addCard({
        name,
        size: blob.size,
        mime,
        objectUrl: URL.createObjectURL(blob),
        path: name,
      });
      rememberContextAsset(name, mime, async () => bytes.slice());
      saved += 1;
    }

    if (saved === 0) {
      showToast('No image data returned (model may have responded with text only)');
    } else {
      showToast(`Saved ${saved} image(s) from Gemini`);
    }
  } catch (error) {
    console.error(error);
    const message = (error as Error)?.message ?? 'Unknown error';
    showToast(`Generation failed: ${message}`);
  } finally {
    generating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate with Gemini and save';
  }
}

function base64ToBytes(data: string) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function buildPromptParts(prompt: string) {
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  if (!attachImagesToPrompt) {
    return parts;
  }
  const assets = Array.from(contextAssets.values());
  if (!assets.length) {
    return parts;
  }

  for (const asset of assets) {
    try {
      const bytes = await asset.getBytes();
      if (!bytes.length) {
        continue;
      }
      parts.push({
        inlineData: {
          mimeType: asset.mime || 'image/png',
          data: bytesToBase64(bytes),
        },
      });
    } catch (error) {
      console.error(error);
    }
  }

  return parts;
}

function rememberContextAsset(
  name: string,
  mime: string,
  getBytes: () => Promise<Uint8Array>,
) {
  const normalizedMime = mime || inferMimeFromName(name);
  if (contextAssets.has(name)) {
    contextAssets.delete(name);
  }
  contextAssets.set(name, {
    name,
    mime: normalizedMime,
    getBytes,
  });
  while (contextAssets.size > MAX_CONTEXT_ASSETS) {
    const oldestKey = contextAssets.keys().next().value as string | undefined;
    if (oldestKey === undefined) {
      break;
    }
    contextAssets.delete(oldestKey);
  }
}

function bytesToBase64(bytes: Uint8Array) {
  if (bytes.length === 0) {
    return '';
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function inferMimeFromName(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

function showToast(message: string) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
  }, 2400);
}

function revokeObjectUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => {
      reject(request.error ?? new Error('Unable to open IndexedDB'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

async function persistDirectoryHandle(handle: FileSystemDirectoryHandle) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(handle, DIR_HANDLE_KEY);
      req.onerror = () => reject(req.error ?? new Error('Failed to save directory handle'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to persist directory handle'));
    });
  } catch (error) {
    console.error(error);
    showToast('Could not persist directory handle');
  }
}

async function loadPersistedDirectoryHandle() {
  try {
    const db = await openDb();
    return await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DIR_HANDLE_KEY);
      req.onerror = () => reject(req.error ?? new Error('Failed to load directory handle'));
      tx.oncomplete = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      tx.onerror = () => reject(tx.error ?? new Error('Failed to read directory handle'));
    });
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

async function removePersistedDirectoryHandle() {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(DIR_HANDLE_KEY);
      req.onerror = () => reject(req.error ?? new Error('Failed to delete directory handle'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear directory handle'));
    });
  } catch (error) {
    console.error(error);
  }
}
