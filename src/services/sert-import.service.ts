import { Notice } from 'obsidian';
import type SbeDocumentsPlugin from '../main';
import type { DocItem } from '../types/documents';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

/** Путь к подготовленному JSON-реестру в вольте (относительно корня вольта). */
const SERT_JSON_PATH = 'sert/Реестр сертификатов TN1.json';
/** Папка с файлами сертификатов (относительно корня вольта). */
const SERT_ROOT = 'sert';

export interface SertImportRecord {
  title: string;
  doc_type: string;
  country: string;
  doc_number: string;
  valid_from: number;
  deadline: number;
  comment: string;
  responsible: string;
  product_group: string;
  trademark: string;
  manufacturer: string;
  tn_ved_code: string;
  testing_lab: string;
  protocol_number: string;
  certification_body: string;
  ik_date: number;
  link_url: string;
  file_rel: string;
}

export interface SertImportFile {
  generated: string;
  source: string;
  doc_types: string[];
  documents: SertImportRecord[];
}

export interface SertImportResult {
  total: number;
  added: number;
  skipped: number;
  withFile: number;
  noFile: number;
}

/** Импорт реестра сертификатов: JSON в вольте + файлы из sert/1. Сертификаты → локальная
 *  БД (sync_status local) с загрузкой файлов в S3; далее push через обычную синхронизацию. */
export class SertImportService {
  private plugin: SbeDocumentsPlugin;

  constructor(plugin: SbeDocumentsPlugin) {
    this.plugin = plugin;
  }

  async importRegistry(): Promise<SertImportResult> {
    const adapter = this.plugin.app.vault.adapter;
    if (!(await adapter.exists(SERT_JSON_PATH))) {
      throw new Error(`Файл реестра не найден: ${SERT_JSON_PATH}`);
    }
    const content = await adapter.read(SERT_JSON_PATH);
    const data = JSON.parse(content) as SertImportFile;
    const records = Array.isArray(data.documents) ? data.documents : [];

    const keyByDoc = new Map<string, DocItem>();
    for (const d of this.plugin.documentsDb.getAll()) {
      keyByDoc.set(this.contentKey(d.doc_number, d.title), d);
    }
    const addedThisRun = new Set<string>();

    const result: SertImportResult = { total: records.length, added: 0, skipped: 0, withFile: 0, noFile: 0 };
    for (const rec of records) {
      const key = this.contentKey(rec.doc_number, rec.title);
      if (addedThisRun.has(key)) {
        result.skipped++;
        continue;
      }
      const existing = keyByDoc.get(key);
      try {
        if (existing) {
          if (existing.file_key || !rec.file_rel) {
            result.skipped++;
            continue;
          }
          // Документ уже есть, но без файла, а у записи файл есть — дозагружаем.
          const file = await this.uploadRecordFile(rec);
          existing.file_key = file.file_key;
          existing.file_name = file.file_name;
          existing.file_size = file.file_size;
          existing.file_url = file.file_url;
          existing.sync_status = 'local';
          existing.updated_at = new Date().toISOString();
          this.plugin.documentsDb.update(existing.id, existing);
          result.withFile++;
          result.added++;
          addedThisRun.add(key);
          continue;
        }
        const doc = await this.buildDoc(rec);
        if (doc.file_key) result.withFile++;
        else result.noFile++;
        this.plugin.documentsDb.add(doc);
        keyByDoc.set(key, doc);
        addedThisRun.add(key);
        this.rememberTypes(rec.doc_type, data.doc_types);
        result.added++;
        if (result.added % 10 === 0) {
          new Notice(`Импорт реестра: обработано ${result.added} из ${records.length}…`);
        }
      } catch (e: unknown) {
        console.warn(`Документы: ошибка импорта «${rec.title}»:`, errorMessage(e));
        result.skipped++;
      }
    }
    await this.plugin.documentsDb.save();
    return result;
  }

  /** Загружает файл записи реестра в S3. */
  private async uploadRecordFile(rec: SertImportRecord): Promise<{ file_key: string; file_name: string; file_size: number; file_url: string }> {
    const vaultRel = `${SERT_ROOT}/${rec.file_rel.replace(/\\/g, '/')}`;
    const buf = await this.plugin.app.vault.adapter.readBinary(vaultRel);
    const base = rec.file_rel.split(/[\\/]/).pop() || 'file.pdf';
    const res = await this.plugin.syncService.uploadFile(buf, base);
    return { file_key: res.file_key, file_name: res.file_name, file_size: res.file_size, file_url: res.file_url };
  }

  private rememberTypes(docType: string, allTypes: string[]): void {
    for (const t of allTypes) this.plugin.documentsDb.addDocType(t);
    this.plugin.documentsDb.addDocType(docType);
  }

  private contentKey(docNumber: string, title: string): string {
    return `${(docNumber || '').trim().toLowerCase()}|${(title || '').trim().toLowerCase()}`;
  }

  private async buildDoc(rec: SertImportRecord): Promise<DocItem> {
    let fileKey = '';
    let fileName = '';
    let fileSize = 0;
    let fileUrl = '';
    if (rec.file_rel) {
      try {
        const res = await this.uploadRecordFile(rec);
        fileKey = res.file_key;
        fileName = res.file_name;
        fileSize = res.file_size;
        fileUrl = res.file_url;
      } catch (e: unknown) {
        console.warn(`Документы: не удалось загрузить файл «${rec.file_rel}»:`, errorMessage(e));
      }
    }

    const now = new Date().toISOString();
    return {
      id: Date.now() + Math.floor(Math.random() * 100000),
      title: rec.title || 'Без названия',
      doc_type: rec.doc_type || '',
      curator_email: 'apotapov@tn.ru',
      deadline: rec.deadline || 0,
      file_key: fileKey,
      file_name: fileName,
      file_size: fileSize,
      file_url: fileUrl,
      link_url: rec.link_url || '',
      link_file_name: '',
      parent_id: 0,
      completed: false,
      remarks: [],
      country: rec.country || '',
      doc_number: rec.doc_number || '',
      valid_from: rec.valid_from || 0,
      comment: rec.comment || '',
      responsible: rec.responsible || '',
      product_group: rec.product_group || '',
      trademark: rec.trademark || '',
      manufacturer: rec.manufacturer || '',
      tn_ved_code: rec.tn_ved_code || '',
      testing_lab: rec.testing_lab || '',
      protocol_number: rec.protocol_number || '',
      certification_body: rec.certification_body || '',
      ik_date: rec.ik_date || 0,
      archived: false,
      created_at: now,
      updated_at: now,
      sync_status: 'local',
    };
  }
}
