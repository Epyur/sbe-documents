import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { DocumentsDatabase } from './database/documents-db';
import { DocumentsSyncService } from './services/sync.service';
import { DocumentsView, SBE_DOCUMENTS_VIEW_TYPE } from './ui/documents-view';
import { DocumentsSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService } from '../../sbe-core/src/bridge';
import type { SbeDocumentsApi } from '../../sbe-core/src/types';
import type { DocItem } from './types/documents';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeDocumentsSettings {
  apiUrl: string;
  defaultAuthor: string;
}

const DEFAULT_SETTINGS: SbeDocumentsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  defaultAuthor: 'И.И. Иванов',
};

const LEGACY_CACHE_PATH = 'yourbase/yougile_cache.json';

export default class SbeDocumentsPlugin extends Plugin {
  settings!: SbeDocumentsSettings;
  documentsDb!: DocumentsDatabase;
  syncService!: DocumentsSyncService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.documentsDb = new DocumentsDatabase(this.app);
    await this.documentsDb.init();
    this.syncService = new DocumentsSyncService(this.documentsDb, () => this.settings.apiUrl);

    // Одноразовая миграция из legacy-кэша монолита (yougile_cache.json, type:document).
    await this.migrateLegacyOnce();

    this.registerView(
      SBE_DOCUMENTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new DocumentsView(leaf, this),
    );

    this.addSettingTab(new DocumentsSettingsTab(this.app, this));

    publishService<SbeDocumentsApi>('sbe-documents', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });
  }

  onunload(): void {
    unpublishService('sbe-documents');
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbeDocumentsSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_DOCUMENTS_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_DOCUMENTS_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Импорт документов (type:document) из yougile_cache.json монолита. Выполняется один раз. */
  private async migrateLegacyOnce(): Promise<void> {
    const removed = this.documentsDb.dedupe();
    if (removed > 0) {
      await this.documentsDb.save();
      console.warn(`Документы: удалено ${removed} дубликатов по id из локальной БД`);
    }

    if (this.documentsDb.getAll().length > 0) return;

    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(LEGACY_CACHE_PATH);
      if (!exists) return;
      const content = await adapter.read(LEGACY_CACHE_PATH);
      const parsed = JSON.parse(content) as {
        tasks?: Array<{
          id: string;
          title: string;
          description: string;
          columnId: string;
          completed: boolean;
          assigned: string[];
          deadline?: number;
        }>;
        columns?: Array<{ id: string; title: string }>;
      };

      const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
      const columns = Array.isArray(parsed.columns) ? parsed.columns : [];
      const colTitle = new Map(columns.map(c => [c.id, c.title]));

      // Сначала собираем все документы, затем маппим taskId -> числовой id.
      const rawDocs: Array<{ doc: DocItem; legacyTaskId: string }> = [];
      for (const t of tasks) {
        if (!t.description) continue;
        const desc = t.description.trim();
        if (!desc.startsWith('{')) continue;
        try {
          const parsedDesc = JSON.parse(desc) as {
            type?: string;
            link?: string;
            fileName?: string;
            curatorEmail?: string;
            parentId?: string;
            remarks?: DocItem['remarks'];
          };
          if (parsedDesc.type !== 'document') continue;
          const id = Date.now() + Math.floor(Math.random() * 100000) + rawDocs.length;
          const parentId = parsedDesc.parentId ? this.taskIdToDocId(parsedDesc.parentId, rawDocs) : 0;
          rawDocs.push({
            legacyTaskId: t.id,
            doc: {
              id,
              title: t.title || '',
              doc_type: colTitle.get(t.columnId) || '',
              curator_email: parsedDesc.curatorEmail || (t.assigned && t.assigned.length > 0 ? t.assigned[0] : ''),
              deadline: t.deadline || 0,
              file_key: '',
              file_name: parsedDesc.fileName || '',
              file_size: 0,
              file_url: '',
              link_url: parsedDesc.link || '',
              link_file_name: parsedDesc.fileName || '',
              parent_id: parentId,
              completed: !!t.completed,
              remarks: Array.isArray(parsedDesc.remarks) ? parsedDesc.remarks : [],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              sync_status: 'local',
            },
          });
        } catch {
          // невалидный JSON — пропускаем
        }
      }

      if (rawDocs.length === 0) return;
      // Второй проход для parentId (родитель может быть объявлен позже).
      for (const item of rawDocs) {
        const parent = rawDocs.find(r => r.legacyTaskId === this.docIdToTaskId(item.doc.parent_id, rawDocs));
        if (parent) item.doc.parent_id = parent.doc.id;
      }

      const added = this.documentsDb.importLegacy(rawDocs.map(r => r.doc));
      await this.documentsDb.save();
      if (added > 0) {
        new Notice(`Документы: импортировано ${added} документов из legacy-БД. Они будут отправлены на сервер при синхронизации.`);
      }
    } catch (e: unknown) {
      console.warn('Документы: не удалось импортировать legacy-БД:', errorMessage(e));
    }
  }

  private taskIdToDocId(taskId: string, docs: Array<{ legacyTaskId: string; doc: DocItem }>): number {
    const found = docs.find(d => d.legacyTaskId === taskId);
    return found ? found.doc.id : 0;
  }

  private docIdToTaskId(docId: number, docs: Array<{ legacyTaskId: string; doc: DocItem }>): string {
    const found = docs.find(d => d.doc.id === docId);
    return found ? found.legacyTaskId : '';
  }
}
