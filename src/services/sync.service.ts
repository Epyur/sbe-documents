import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { DocumentsDatabase } from '../database/documents-db';
import type { DocItem, PushResponse, PullResponse, UploadFileResponse } from '../types/documents';

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/** Синхронизация с documents-service через JWT из ЦУП. Сервер — канон, локально — кэш. */
export class DocumentsSyncService {
  private db: DocumentsDatabase;
  private getApiUrl: () => string;

  constructor(db: DocumentsDatabase, getApiUrl: () => string) {
    this.db = db;
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  async sync(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAll().filter(d => d.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      for (const d of dirty) d.sync_status = 'synced';
      await this.db.save();
    }
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.documents);
    await this.db.save();
    return { pushed, pulled: pulled.documents.length };
  }

  /** Только pull + merge (для повторной миграции). */
  async pullAndMerge(): Promise<number> {
    const token = await this.getToken();
    const pulled = await this.pull(token);
    this.db.mergeFromServer(pulled.documents);
    await this.db.save();
    return pulled.documents.length;
  }

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('documents');
  }

  private async push(token: string, docs: DocItem[]): Promise<PushResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/sync/push`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ documents: docs }),
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PushResponse;
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе push:', errorMessage(e));
      return { inserted: 0, updated: 0 };
    }
  }

  private async pull(token: string): Promise<PullResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as PullResponse;
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе pull:', errorMessage(e));
      return { documents: [] };
    }
  }

  /** Возвращает роль текущего пользователя ({email, role, hasAccess}). */
  async getMyPermission(): Promise<{ email: string; role: string; hasAccess: boolean }> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/permissions/me`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as { email: string; role: string; hasAccess: boolean };
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе permissions/me:', errorMessage(e));
      return { email: '', role: '', hasAccess: false };
    }
  }

  /** Список прав (для admin). */
  async listPermissions(): Promise<Array<{ email: string; role: string }>> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/permissions`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { permissions?: Array<{ email: string; role: string }> };
      return Array.isArray(data.permissions) ? data.permissions : [];
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе permissions:', errorMessage(e));
      return [];
    }
  }

  /** Устанавливает/отзывает роль (для admin). role='' — отозвать. */
  async setPermission(email: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/permissions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    this.assertOk(res);
  }

  /** Текущий уровень общего доступа (для admin). */
  async getCommonAccess(): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/common-access`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { level?: string };
      return data.level || '';
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе common-access:', errorMessage(e));
      return '';
    }
  }

  /** Настройки уведомлений об истечении срока (для admin). */
  async getNotifySettings(): Promise<{ enabled: boolean; days: number[] }> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/notify-settings`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { enabled?: boolean; days?: number[] };
      return { enabled: !!data.enabled, days: Array.isArray(data.days) ? data.days : [] };
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе notify-settings:', errorMessage(e));
      return { enabled: false, days: [] };
    }
  }

  /** Сохраняет настройки уведомлений об истечении срока (для admin). */
  async setNotifySettings(input: { enabled: boolean; days: number[] }): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/notify-settings`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
    });
    this.assertOk(res);
  }

  /** Устанавливает уровень общего доступа (для admin). level='' — отключить. */
  async setCommonAccess(level: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/common-access`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level }),
    });
    this.assertOk(res);
  }

  /** Загружает файл документа в S3 через сервис. Возвращает file_key/file_url. */
  async uploadFile(data: ArrayBuffer, fileName: string): Promise<UploadFileResponse> {
    const token = await this.getToken();
    const boundary = '----sbe-documents-' + Date.now().toString(36);
    const body = this.buildMultipart(data, fileName, boundary);
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/file`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }, 120000);
    this.assertOk(res);
    return JSON.parse(res.text) as UploadFileResponse;
  }

  /** Скачивает файл из S3 через сервис (GET /api/documents/file?key=...). */
  async downloadFile(fileKey: string): Promise<ArrayBuffer> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/file?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 120000);
    this.assertOk(res);
    return res.arrayBuffer;
  }

  /** Возвращает временную публичную ссылку на файл (GET /api/documents/file-link?key=...). */
  async getFileLink(fileKey: string): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/file-link?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 60000);
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { url?: string };
      return data.url || '';
    } catch (e: unknown) {
      console.warn('Документы: не JSON в ответе file-link:', errorMessage(e));
      return '';
    }
  }

  /** Загружает файл замечания в S3 через сервис. */
  async uploadRemarkFile(data: ArrayBuffer, fileName: string, documentId: number): Promise<UploadFileResponse> {
    const token = await this.getToken();
    const boundary = '----sbe-documents-' + Date.now().toString(36);
    const body = this.buildMultipart(data, fileName, boundary, String(documentId));
    const res = await this.request({
      url: `${this.baseUrl}/api/documents/remark-file`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }, 120000);
    this.assertOk(res);
    return JSON.parse(res.text) as UploadFileResponse;
  }

  private buildMultipart(data: ArrayBuffer, fileName: string, boundary: string, documentId?: string): ArrayBuffer {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const filePart = documentId
      ? enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="document_id"\r\n\r\n${documentId}\r\n`)
      : new Uint8Array(0);
    parts.push(filePart);
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(new Uint8Array(data));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out.buffer;
  }

  private assertOk(res: { status: number; text: string }): void {
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к документам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('Документы: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда. */
  private async request(
    param: RequestUrlParam,
    timeoutMs = 30000,
  ): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}
