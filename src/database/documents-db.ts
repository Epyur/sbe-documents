import { App } from 'obsidian';
import type { DocItem, DocumentsDbData, DocumentRemark } from '../types/documents';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_documents';
const DB_PATH = 'yourbase/sbe_documents/documents_data.json';

/** Локальная БД документов (кэш; сервер — каноническое хранилище). */
export class DocumentsDatabase {
  private app: App;
  private data: DocumentsDbData = { documents: [], doc_types: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const content = await adapter.read(DB_PATH);
        const parsed = JSON.parse(content) as Partial<DocumentsDbData>;
        this.data = {
          documents: Array.isArray(parsed.documents) ? parsed.documents : [],
          doc_types: Array.isArray(parsed.doc_types) ? parsed.doc_types : [],
        };
      }
    } catch (e: unknown) {
      console.error('Документы: не удалось прочитать БД:', errorMessage(e));
    }
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  async save(): Promise<void> {
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('Документы: не удалось сохранить БД:', errorMessage(e));
    }
  }

  getAll(): DocItem[] {
    return this.data.documents;
  }

  getById(id: number): DocItem | undefined {
    return this.data.documents.find(d => d.id === id);
  }

  add(doc: DocItem): void {
    const idx = this.data.documents.findIndex(d => d.id === doc.id);
    if (idx !== -1) {
      this.data.documents[idx] = doc;
    } else {
      this.data.documents.push(doc);
    }
    this.rememberDocType(doc.doc_type);
  }

  update(id: number, updates: Partial<DocItem>): void {
    const idx = this.data.documents.findIndex(d => d.id === id);
    if (idx !== -1) {
      this.data.documents[idx] = { ...this.data.documents[idx], ...updates };
    }
  }

  delete(id: number): void {
    this.data.documents = this.data.documents.filter(d => d.id !== id);
  }

  getDocTypes(): string[] {
    return this.data.doc_types;
  }

  /** Добавляет тип документа в локальный реестр (для datalist), если его ещё нет. */
  addDocType(name: string): boolean {
    const trimmed = (name || '').trim();
    if (!trimmed) return false;
    if (this.data.doc_types.includes(trimmed)) return false;
    this.data.doc_types.push(trimmed);
    return true;
  }

  private rememberDocType(t: string): void {
    const trimmed = (t || '').trim();
    if (!trimmed) return;
    if (!this.data.doc_types.includes(trimmed)) {
      this.data.doc_types.push(trimmed);
    }
  }

  /** Удаляет дубликаты по id, оставляя самую свежую запись. */
  dedupe(): number {
    const seen = new Map<number, number>();
    const keep: DocItem[] = [];
    let removed = 0;
    for (const d of this.data.documents) {
      const existing = seen.get(d.id);
      if (existing === undefined) {
        seen.set(d.id, keep.length);
        keep.push(d);
        continue;
      }
      const prev = keep[existing];
      if (this.compareTime(d.updated_at, prev.updated_at) >= 0) {
        keep[existing] = d;
      }
      removed++;
    }
    this.data.documents = keep;
    return removed;
  }

  /** Слияние документов с сервера (канон). Сервер авторитетен при равном/новом updated_at. */
  mergeFromServer(serverDocs: DocItem[]): void {
    for (const s of serverDocs) {
      const local = this.getById(s.id);
      if (!local) {
        this.add({ ...s, sync_status: 'synced' });
        continue;
      }
      if (this.compareTime(s.updated_at, local.updated_at) >= 0) {
        this.data.documents[this.data.documents.indexOf(local)] = { ...s, sync_status: 'synced' };
        this.rememberDocType(s.doc_type);
      }
    }
  }

  /** Импорт из легаси-задач YouGile (одноразовая миграция).
   *  Устойчив к повторным запускам: пропускает записи с тем же id ИЛИ тем же
   *  содержимым (title + link_url/file_name), чтобы не плодить дубликаты. */
  importLegacy(docs: DocItem[]): number {
    const now = new Date().toISOString();
    let added = 0;
    const existingKeys = new Set(this.data.documents.map(d => this.contentKey(d)));
    for (const d of docs) {
      if (this.getById(d.id)) continue;
      if (existingKeys.has(this.contentKey(d))) continue;
      this.data.documents.push({
        ...d,
        remarks: Array.isArray(d.remarks) ? d.remarks : [],
        sync_status: 'local',
        created_at: d.created_at || now,
        updated_at: d.updated_at || d.created_at || now,
      });
      this.rememberDocType(d.doc_type);
      existingKeys.add(this.contentKey(d));
      added++;
    }
    return added;
  }

  /** Ключ содержимого для дедупликации миграции (title + ссылка/файл). */
  private contentKey(d: DocItem): string {
    return `${(d.title || '').trim().toLowerCase()}|${(d.link_url || d.file_name || '').trim().toLowerCase()}`;
  }

  private compareTime(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }
}

export type { DocumentRemark };
