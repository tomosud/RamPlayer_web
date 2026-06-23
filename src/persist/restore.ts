/**
 * リロード後の復元。
 *
 * - `DataTransferItem.getAsFileSystemHandle()` でハンドルを取得できた場合のみ、
 *   IndexedDB へハンドル＋設定（ファイル名・最終再生位置・In/Out・ループ）を保存する。
 * - ハンドルを取得できないブラウザでは設定のみ保存し、動画本体は保存しない
 *   （巨大な Blob を IndexedDB へ複製しない）。
 */

export interface PersistedSettings {
  name: string;
  lastTime: number;
  inPoint: number;
  outPoint: number;
  loop: boolean;
}

export interface PersistedRecord {
  handle: FileSystemFileHandle | null;
  settings: PersistedSettings;
  savedAt: number;
}

const DB_NAME = 'ramplayer';
const STORE = 'state';
const KEY = 'last';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(value: PersistedRecord): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet(): Promise<PersistedRecord | undefined> {
  const db = await openDb();
  const value = await new Promise<PersistedRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as PersistedRecord | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

export async function clearPersisted(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** ドロップされた item から FileSystemFileHandle を取得（対応ブラウザのみ）。 */
export async function getHandleFromDrop(item: DataTransferItem): Promise<FileSystemFileHandle | null> {
  const anyItem = item as DataTransferItem & {
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
  };
  if (typeof anyItem.getAsFileSystemHandle !== 'function') return null;
  try {
    const handle = await anyItem.getAsFileSystemHandle();
    if (handle && handle.kind === 'file') return handle as FileSystemFileHandle;
  } catch {
    /* ignore */
  }
  return null;
}

export async function savePersisted(
  handle: FileSystemFileHandle | null,
  settings: PersistedSettings,
): Promise<void> {
  try {
    await idbPut({ handle, settings, savedAt: Date.now() });
  } catch {
    /* 保存失敗は致命的ではない */
  }
}

export async function loadPersisted(): Promise<PersistedRecord | undefined> {
  try {
    return await idbGet();
  } catch {
    return undefined;
  }
}

type PermissionState = 'granted' | 'denied' | 'prompt';

interface HandleWithPermission extends FileSystemFileHandle {
  queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export async function queryReadPermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const h = handle as HandleWithPermission;
  if (typeof h.queryPermission !== 'function') return 'prompt';
  try {
    return await h.queryPermission({ mode: 'read' });
  } catch {
    return 'prompt';
  }
}

/** ユーザー操作（クリック）内で呼ぶこと。 */
export async function requestReadPermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const h = handle as HandleWithPermission;
  if (typeof h.requestPermission !== 'function') return 'prompt';
  try {
    return await h.requestPermission({ mode: 'read' });
  } catch {
    return 'denied';
  }
}

/** ハンドルから File を取得。ファイルが移動・削除されている場合は null。 */
export async function fileFromHandle(handle: FileSystemFileHandle): Promise<File | null> {
  try {
    return await handle.getFile();
  } catch {
    return null;
  }
}
