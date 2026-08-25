import { Plugin, WorkspaceLeaf, Notice } from 'obsidian';
import { DocumentsDatabase } from './database/documents-db';
import { DocumentsSyncService } from './services/sync.service';
import { SertImportService, SertImportResult } from './services/sert-import.service';
import { DocumentsView, SBE_DOCUMENTS_VIEW_TYPE } from './ui/documents-view';
import { DocumentsSettingsTab } from './ui/settings-tab';
import { publishService, unpublishService, getService } from '../../sbe-core/src/bridge';
import type { SbeDocumentsApi } from '../../sbe-core/src/types';
import type { DocItem } from './types/documents';
import { errorMessage } from '../../sbe-core/src/utils/errors';

export interface SbeDocumentsSettings {
  apiUrl: string;
  defaultAuthor: string;
  /** Флаг одноразовой миграции из legacy-кэша монолита (защита от повторного импорта). */
  legacyMigrated: boolean;
  /** Флаг импорта реестра сертификатов из sert/Реестр сертификатов TN1.json. */
  sertImported: boolean;
  /** Версия, для которой уже опубликована новость в «Новости» ЦУП (однократно на версию). */
  lastAnnouncedVersion: string;
}

const DEFAULT_SETTINGS: SbeDocumentsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  defaultAuthor: 'И.И. Иванов',
  legacyMigrated: false,
  sertImported: false,
  lastAnnouncedVersion: '',
};

const LEGACY_CACHE_PATH = 'yourbase/yougile_cache.json';

export default class SbeDocumentsPlugin extends Plugin {
  settings!: SbeDocumentsSettings;
  documentsDb!: DocumentsDatabase;
  syncService!: DocumentsSyncService;
  sertImportService!: SertImportService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.documentsDb = new DocumentsDatabase(this.app);
    await this.documentsDb.init();
    this.syncService = new DocumentsSyncService(this.documentsDb, () => this.settings.apiUrl);
    this.sertImportService = new SertImportService(this);

    // Одноразовая миграция из legacy-кэша монолита (yougile_cache.json, type:document).
    await this.migrateLegacyOnce();

    // Одноразовый импорт реестра сертификатов (sert/Реестр сертификатов TN1.json).
    await this.migrateSertOnce();

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

    // Новость об обновлении — один раз на версию (см. канал «Новости» ЦУП).
    void this.announceOnce();
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

    // Флаг в настройках гарантирует одноразовость даже при пустой/очищенной локальной БД
    // (иначе повторный запуск плагина дублировал бы все legacy-документы с новыми id).
    if (this.settings.legacyMigrated) return;
    if (this.documentsDb.getAll().length > 0) {
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      return;
    }

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
              country: '',
              doc_number: '',
              valid_from: 0,
              comment: '',
              responsible: '',
              product_group: '',
              trademark: '',
              manufacturer: '',
              tn_ved_code: '',
              testing_lab: '',
              protocol_number: '',
              certification_body: '',
              ik_date: 0,
              archived: false,
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
      this.settings.legacyMigrated = true;
      await this.saveSettings();
      if (added > 0) {
        new Notice(`Документы: импортировано ${added} документов из legacy-БД. Они будут отправлены на сервер при синхронизации.`);
      }
    } catch (e: unknown) {
      console.warn('Документы: не удалось импортировать legacy-БД:', errorMessage(e));
    }
  }

  /** Импорт реестра сертификатов (sert/Реестр сертификатов TN1.json) с загрузкой
   *  файлов в S3. Повторный запуск безвреден — пропускаются записи с тем же
   *  номером и названием. */
  async importSertRegistry(): Promise<SertImportResult> {
    const result = await this.sertImportService.importRegistry();
    if (result.added > 0) {
      this.settings.sertImported = true;
      await this.saveSettings();
    }
    return result;
  }

  /** Одноразовый автоматический импорт реестра сертификатов при первом запуске
   *  (флаг sertImported в настройках). Ошибки не блокируют загрузку плагина. */
  private async migrateSertOnce(): Promise<void> {
    if (this.settings.sertImported) return;
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists('sert/Реестр сертификатов TN1.json'))) return;
      new Notice('Документы: начинаю импорт реестра сертификатов…');
      const result = await this.sertImportService.importRegistry();
      this.settings.sertImported = true;
      await this.saveSettings();
      if (result.added > 0) {
        new Notice(`Документы: импортировано ${result.added} документов (с файлами: ${result.withFile}, без файла: ${result.noFile}).`);
        try {
          const synced = await this.syncService.sync();
          new Notice(`Документы: на сервер отправлено документов: ${synced.pushed}.`);
        } catch (e: unknown) {
          console.warn('Документы: синхронизация после импорта не выполнена:', errorMessage(e));
        }
      }
    } catch (e: unknown) {
      console.warn('Документы: не удалось импортировать реестр:', errorMessage(e));
    }
  }

  /** Публикация новости в канал «Новости» ЦУП — один раз на версию. */
  private async announceOnce(): Promise<void> {
    if (this.settings.lastAnnouncedVersion === this.manifest.version) return;
    try {
      const apstore = await getService('sbe-apstore');
      await apstore.announceUpdate({
        appId: this.manifest.id,
        appName: this.manifest.name,
        version: this.manifest.version,
        summary: 'Плагин «Документы»: добавлены архив документов (в т.ч. автоматический по истечении срока), фильтры «Действующие» и «Архивные документы», сортировка по сроку действия, страница «Настройки реестра» с управлением группами типов, настройки уведомлений об истечении срока.',
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('Документы: не удалось опубликовать новость об обновлении:', errorMessage(e));
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
