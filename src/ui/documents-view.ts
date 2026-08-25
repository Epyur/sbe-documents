import { ItemView, Notice, WorkspaceLeaf, FileSystemAdapter } from 'obsidian';
import type SbeDocumentsPlugin from '../main';
import type { DocItem, DocumentRemark } from '../types/documents';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { buildXlsx } from '../utils/xlsx-writer';

export const SBE_DOCUMENTS_VIEW_TYPE = 'sbe-documents-view';

type NavKey = 'documents';

/** Контролы полей реестра (колонки Excel) в форме создания/редактирования. */
interface RegistryControls {
  docNumber: HTMLInputElement;
  country: HTMLInputElement;
  validFrom: HTMLInputElement;
  comment: HTMLTextAreaElement;
  responsible: HTMLInputElement;
  productGroup: HTMLInputElement;
  trademark: HTMLInputElement;
  manufacturer: HTMLInputElement;
  tnVedCode: HTMLInputElement;
  testingLab: HTMLTextAreaElement;
  protocolNumber: HTMLTextAreaElement;
  certificationBody: HTMLInputElement;
  ikDate: HTMLInputElement;
}

const PAGE_META: Record<NavKey, { title: string; sub: string }> = {
  documents: { title: 'Все документы', sub: 'Реестр документов' },
};

/** Расширения, которые Obsidian открывает встроенным просмотрщиком. */
const OBSIDIAN_VIEWABLE = new Set([
  'md', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'txt', 'csv', 'html', 'htm',
]);

export class DocumentsView extends ItemView {
  plugin: SbeDocumentsPlugin;
  private rootEl!: HTMLElement;
  private navEl!: HTMLElement;
  private filtersEl!: HTMLElement;
  private countryFiltersEl!: HTMLElement;
  private pageTitleEl!: HTMLElement;
  private pageSubEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private collapseLabel!: HTMLElement;
  private bodyEl!: HTMLElement;
  private key: NavKey = 'documents';
  private collapsed = false;
  private selectedDocTypes: Set<string> = new Set();
  private selectedCountries: Set<string> = new Set();
  private searchQuery = '';
  private searchTimeout: number | null = null;
  private myRole = '';

  constructor(leaf: WorkspaceLeaf, plugin: SbeDocumentsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_DOCUMENTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicTEAM.Документы';
  }

  getIcon(): string {
    return 'file-text';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-doc-container');
    this.rootEl = container.createDiv({ cls: 'tn-doc-app' });

    try {
      const me = await this.plugin.syncService.getMyPermission();
      this.myRole = me.hasAccess ? me.role : '';
    } catch (e: unknown) {
      console.warn('Документы: не удалось получить роль:', errorMessage(e));
      this.myRole = '';
    }

    this.buildShell();
    this.syncNavActive();
    this.renderPage();
  }

  refresh(): void {
    this.renderPage();
  }
  // ---- Каркас ----

  private buildShell(): void {
    // шапка
    const topbar = this.rootEl.createDiv({ cls: 'tn-doc-topbar' });
    topbar.createDiv({ cls: 'tn-doc-module-title', text: 'LogicTEAM.Документы' });
    this.crumbEl = topbar.createDiv({ cls: 'tn-doc-crumb' });
    const spacer = topbar.createDiv({ cls: 'tn-doc-spacer' });
    spacer.empty();
    if (this.canEdit) {
      const createBtn = topbar.createEl('button', { text: '＋ Создать', cls: 'tn-doc-create' });
      createBtn.addEventListener('click', () => this.showCreateForm());
    }

    // главная область: сайдбар + контент
    const main = this.rootEl.createDiv({ cls: 'tn-doc-main' });

    const sidebar = main.createDiv({ cls: 'tn-doc-sidebar' });

    // сворачивание
    const collapseBtn = sidebar.createDiv({ cls: 'tn-doc-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    this.collapseLabel = collapseBtn.createSpan({ cls: 'tn-doc-collapse-lbl', text: 'Свернуть' });
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    // дерево навигации + фильтры по типам
    this.navEl = sidebar.createDiv({ cls: 'tn-doc-nav' });
    this.buildNav();

    // панель управления: синхронизация и экспорт
    const actions = sidebar.createDiv({ cls: 'tn-doc-sidebar-actions' });
    const syncBtn = actions.createEl('button', { cls: 'tn-doc-nav-action' });
    syncBtn.createSpan({ text: '🔄' });
    syncBtn.createSpan({ cls: 'tn-doc-nav-lbl', text: 'Синхронизация' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });
    const exportBtn = actions.createEl('button', { cls: 'tn-doc-nav-action' });
    exportBtn.createSpan({ text: '📄' });
    exportBtn.createSpan({ cls: 'tn-doc-nav-lbl', text: 'Экспорт HTML' });
    exportBtn.addEventListener('click', () => { void this.exportHtml(); });
    const exportXlsxBtn = actions.createEl('button', { cls: 'tn-doc-nav-action' });
    exportXlsxBtn.createSpan({ text: '📊' });
    exportXlsxBtn.createSpan({ cls: 'tn-doc-nav-lbl', text: 'Экспорт Excel' });
    exportXlsxBtn.addEventListener('click', () => { void this.exportExcel(); });
    if (this.canEdit) {
      const importBtn = actions.createEl('button', { cls: 'tn-doc-nav-action' });
      importBtn.createSpan({ text: '📥' });
      importBtn.createSpan({ cls: 'tn-doc-nav-lbl', text: 'Импорт реестра' });
      importBtn.addEventListener('click', () => { void this.importRegistry(); });
    }

    const content = main.createDiv({ cls: 'tn-doc-content' });
    this.pageTitleEl = content.createEl('h1', { cls: 'tn-doc-page-title' });
    this.pageSubEl = content.createDiv({ cls: 'tn-doc-page-sub' });
    this.bodyEl = content.createDiv();
  }

  private buildNav(): void {
    this.navEl.empty();

    // Группа «Документы»
    const docGroup = this.navEl.createEl('button', { cls: 'tn-doc-grp' });
    docGroup.createSpan({ cls: 'tn-doc-grp-ico', text: '📄' });
    docGroup.createSpan({ cls: 'tn-doc-grp-lbl', text: 'Документы' });
    docGroup.createSpan({ cls: 'tn-doc-grp-chev', text: '▶' });
    docGroup.addEventListener('click', () => {
      docGroup.classList.toggle('open');
      docGroup.classList.toggle('active');
    });
    const docSubmenu = this.navEl.createDiv({ cls: 'tn-doc-submenu' });
    const allDocs = docSubmenu.createEl('a', { cls: 'tn-doc-nav-item', attr: { href: '#' } });
    allDocs.createSpan({ cls: 'tn-doc-nav-lbl', text: 'Все документы' });
    allDocs.dataset.key = 'documents';
    allDocs.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.key = 'documents';
      this.syncNavActive();
      this.renderPage();
    });
    docGroup.classList.add('open', 'active');

    // Группа «Фильтры» — чекбоксы типов документов
    const filterGroup = this.navEl.createEl('button', { cls: 'tn-doc-grp' });
    filterGroup.createSpan({ cls: 'tn-doc-grp-ico', text: '🔍' });
    filterGroup.createSpan({ cls: 'tn-doc-grp-lbl', text: 'Фильтры' });
    filterGroup.createSpan({ cls: 'tn-doc-grp-chev', text: '▶' });
    filterGroup.addEventListener('click', () => {
      filterGroup.classList.toggle('open');
      filterGroup.classList.toggle('active');
    });
    this.filtersEl = this.navEl.createDiv({ cls: 'tn-doc-submenu tn-doc-filters-nav' });
    filterGroup.classList.add('open');
    this.renderSidebarFilters();

    // Группа «Страна» — чекбоксы стран документов
    const countryGroup = this.navEl.createEl('button', { cls: 'tn-doc-grp' });
    countryGroup.createSpan({ cls: 'tn-doc-grp-ico', text: '🌍' });
    countryGroup.createSpan({ cls: 'tn-doc-grp-lbl', text: 'Страна' });
    countryGroup.createSpan({ cls: 'tn-doc-grp-chev', text: '▶' });
    countryGroup.addEventListener('click', () => {
      countryGroup.classList.toggle('open');
      countryGroup.classList.toggle('active');
    });
    this.countryFiltersEl = this.navEl.createDiv({ cls: 'tn-doc-submenu tn-doc-filters-nav' });
    countryGroup.classList.add('open');
    this.renderSidebarCountryFilters();

    this.syncNavActive();
  }

  /** Чекбоксы фильтров по типам документов (в группе «Фильтры» сайдбара). */
  private renderSidebarFilters(): void {
    if (!this.filtersEl) return;
    this.filtersEl.empty();
    const types = this.plugin.documentsDb.getDocTypes();
    if (types.length === 0) {
      this.filtersEl.createDiv({ cls: 'tn-doc-nav-empty' }).setText('Типов пока нет');
      return;
    }
    for (const t of types) {
      const wrapper = this.filtersEl.createEl('label', { cls: 'tn-doc-filter-label tn-doc-sidebar-filter' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
      cb.checked = this.selectedDocTypes.has(t);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedDocTypes.add(t);
        else this.selectedDocTypes.delete(t);
        this.renderPage();
      });
      wrapper.createEl('span').setText(t);
    }
  }

  /** Чекбоксы фильтров по странам (в группе «Страна» сайдбара). */
  private renderSidebarCountryFilters(): void {
    if (!this.countryFiltersEl) return;
    this.countryFiltersEl.empty();
    const countries = new Set<string>();
    for (const d of this.plugin.documentsDb.getAll()) {
      if (d.country) countries.add(d.country);
    }
    const list = Array.from(countries).sort((a, b) => a.localeCompare(b, 'ru'));
    if (list.length === 0) {
      this.countryFiltersEl.createDiv({ cls: 'tn-doc-nav-empty' }).setText('Стран пока нет');
      return;
    }
    for (const c of list) {
      const wrapper = this.countryFiltersEl.createEl('label', { cls: 'tn-doc-filter-label tn-doc-sidebar-filter' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
      cb.checked = this.selectedCountries.has(c);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selectedCountries.add(c);
        else this.selectedCountries.delete(c);
        this.renderPage();
      });
      wrapper.createEl('span').setText(c);
    }
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.rootEl.classList.toggle('collapsed', this.collapsed);
    if (this.collapseLabel) {
      this.collapseLabel.setText(this.collapsed ? 'Развернуть' : 'Свернуть');
    }
  }

  private syncNavActive(): void {
    this.navEl.querySelectorAll('.tn-doc-nav-item').forEach((el) => {
      const navEl = el as HTMLElement;
      navEl.classList.toggle('active', navEl.dataset.key === this.key);
    });
  }

  // ---- Страница ----

  private renderPage(): void {
    const meta = PAGE_META[this.key];
    this.crumbEl.setText(meta.title);
    this.pageTitleEl.setText(meta.title);
    this.pageSubEl.setText(meta.sub);

    this.bodyEl.empty();
    this.renderDocumentsView();
  }

  /** Роль editor/admin — можно создавать/редактировать документы. */
  private get canEdit(): boolean {
    return this.myRole === 'editor' || this.myRole === 'admin';
  }

  /** Роль commenter+ — можно добавлять замечания. */
  private get canComment(): boolean {
    return this.myRole === 'commenter' || this.myRole === 'editor' || this.myRole === 'admin';
  }

  // ---- Список: карточки с вложенными связанными документами ----

  private renderDocumentsView(): void {
    const container = this.bodyEl;
    container.empty();

    const searchInput = container.createEl('input', {
      attr: { type: 'text', placeholder: '🔍 Поиск по названию...' },
      cls: 'tn-doc-input tn-doc-mb8',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderDocumentsView(), 400);
    });

    const { byParent } = this.getTree();
    const visible = this.getVisibleRoots();

    if (visible.length === 0) {
      container.createDiv({ cls: 'tn-doc-meta tn-doc-p24' }).setText('Нет документов');
      return;
    }

    for (const r of visible) {
      this.renderCard(r, byParent, container);
    }
  }

  /** Дерево документов: корни и связанные (parent_id) по каждому родителю. */
  private getTree(): { roots: DocItem[]; byParent: Map<number, DocItem[]> } {
    const all = this.plugin.documentsDb.getAll();
    const ids = new Set(all.map(d => d.id));
    const byParent = new Map<number, DocItem[]>();
    const roots: DocItem[] = [];
    for (const d of all) {
      if (d.parent_id > 0 && ids.has(d.parent_id)) {
        const list = byParent.get(d.parent_id) || [];
        list.push(d);
        byParent.set(d.parent_id, list);
      } else {
        roots.push(d);
      }
    }
    const byId = (a: DocItem, b: DocItem): number => a.id - b.id;
    roots.sort(byId);
    for (const list of byParent.values()) list.sort(byId);
    return { roots, byParent };
  }

  /** Корневые документы, попавшие в текущий фильтр (поиск + типы + страны). */
  private getVisibleRoots(): DocItem[] {
    const { roots, byParent } = this.getTree();
    const q = this.searchQuery.trim().toLowerCase();
    return roots.filter(r => this.subtreeMatches(r, byParent, q));
  }

  /** Совпадение документа с поиском и выбранными типами/странами. */
  private matches(d: DocItem, q: string): boolean {
    const qOk = !q || d.title.toLowerCase().includes(q);
    const tOk = this.selectedDocTypes.size === 0 || this.selectedDocTypes.has(d.doc_type);
    const cOk = this.selectedCountries.size === 0 || this.selectedCountries.has(d.country || '');
    return qOk && tOk && cOk;
  }

  /** Карточка показывается, если сам документ или любой вложенный совпал с фильтрами. */
  private subtreeMatches(d: DocItem, byParent: Map<number, DocItem[]>, q: string): boolean {
    if (this.matches(d, q)) return true;
    const kids = byParent.get(d.id) || [];
    return kids.some(k => this.subtreeMatches(k, byParent, q));
  }

  private renderCard(doc: DocItem, byParent: Map<number, DocItem[]>, container: HTMLElement): void {
    const card = container.createDiv({ cls: 'tn-doc-card' });
    const head = card.createDiv({ cls: 'tn-doc-card-head' });
    const titleEl = head.createEl('h4', { text: doc.title || 'Без названия' });
    titleEl.addClass('tn-doc-card-title');
    if (doc.completed) titleEl.addClass('tn-doc-completed');
    if (doc.deadline) {
      const daysLeft = Math.ceil((doc.deadline - Date.now()) / 86400000);
      const chipCls = doc.completed
        ? 'tn-doc-chip-green'
        : daysLeft < 0 ? 'tn-doc-chip-red' : daysLeft <= 7 ? 'tn-doc-chip-orange' : 'tn-doc-chip-green';
      head.createSpan({ cls: `tn-doc-chip ${chipCls}`, text: new Date(doc.deadline).toLocaleDateString() });
    }

    const metaParts: string[] = [];
    if (doc.doc_number) metaParts.push(`🆔 ${doc.doc_number}`);
    if (doc.doc_type) metaParts.push(`📂 ${doc.doc_type}`);
    if (doc.country) metaParts.push(`🌍 ${doc.country}`);
    if (doc.responsible) metaParts.push(`👤 ${doc.responsible}`);
    metaParts.push(doc.completed ? '✅ Завершён' : '🟢 Активен');
    card.createDiv({ cls: 'tn-doc-card-meta', text: metaParts.join(' · ') });

    if (doc.file_key) {
      const fileBtn = card.createEl('a', { attr: { href: '#' }, cls: 'tn-doc-card-file' });
      fileBtn.setText(`📎 ${doc.file_name || 'Скачать'}`);
      fileBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.downloadAndOpen(doc.file_key, doc.file_name || 'file');
      });
    } else if (doc.link_url) {
      const extLink = card.createEl('a', { href: doc.link_url, attr: { target: '_blank' }, cls: 'tn-doc-card-file' });
      extLink.setText(`🔗 ${doc.link_file_name || 'Ссылка'}`);
      extLink.addEventListener('click', (e) => e.stopPropagation());
    }

    const kids = byParent.get(doc.id) || [];
    if (kids.length > 0) {
      const list = card.createDiv({ cls: 'tn-doc-card-children' });
      for (const k of kids) this.renderChildItem(k, byParent, list);
    }

    card.addEventListener('click', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'A' || tag === 'INPUT') return;
      this.renderDocumentDetail(doc);
    });
  }

  private renderChildItem(doc: DocItem, byParent: Map<number, DocItem[]>, host: HTMLElement): void {
    const item = host.createDiv({ cls: 'tn-doc-child-item' });
    const title = item.createEl('span', { text: doc.title || 'Без названия' });
    title.addClass('tn-doc-child-title');
    if (doc.completed) title.addClass('tn-doc-completed');
    if (doc.file_key) {
      const dl = item.createEl('a', { attr: { href: '#', title: 'Скачать файл' }, cls: 'tn-doc-child-file' });
      dl.setText('📎');
      dl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void this.downloadAndOpen(doc.file_key, doc.file_name || 'file');
      });
    }
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).tagName === 'A') return;
      this.renderDocumentDetail(doc);
    });

    const kids = byParent.get(doc.id) || [];
    if (kids.length > 0) {
      const nested = host.createDiv({ cls: 'tn-doc-child-nested' });
      for (const k of kids) this.renderChildItem(k, byParent, nested);
    }
  }

  // ---- Карточка документа (детали) ----

  private renderDocumentDetail(doc: DocItem): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderDocumentsView());

    container.createEl('h3', { text: doc.title });

    const meta = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
    meta.createDiv({ text: `📂 Тип документа: ${doc.doc_type || '—'}` });
    meta.createDiv({ text: `👤 Куратор: ${doc.curator_email || '—'}` });
    if (doc.deadline) meta.createDiv({ text: `📅 Срок действия: ${new Date(doc.deadline).toLocaleDateString()}` });
    meta.createDiv({ text: `✅ Статус: ${doc.completed ? 'Завершён' : 'Активен'}` });
    if (doc.parent_id > 0) {
      const parent = this.plugin.documentsDb.getById(doc.parent_id);
      meta.createDiv({ text: `📎 Входит в: ${parent ? parent.title : '—'}` });
    }

    this.renderRegistryDetail(doc, container);

    if (doc.file_key) {
      const linkDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
      linkDiv.createDiv({ text: 'Файл документа:' });
      const a = linkDiv.createEl('a', { attr: { href: '#' } });
      a.setText(doc.file_name || 'Скачать');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        void this.downloadAndOpen(doc.file_key, doc.file_name || 'file');
      });
    } else if (doc.link_url) {
      const linkDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
      linkDiv.createDiv({ text: 'Ссылка на документ:' });
      const a = linkDiv.createEl('a', { href: doc.link_url, attr: { target: '_blank' } });
      a.setText(doc.link_file_name || 'Ссылка');
    }

    const related = this.plugin.documentsDb.getAll().filter(d => d.parent_id === doc.id);
    if (related.length > 0) {
      const relatedDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
      relatedDiv.createDiv({ text: `📎 Связанные документы (${related.length}):` });
      for (const rd of related) {
        const row = relatedDiv.createEl('div', { cls: 'tn-doc-clickable' });
        row.setText(rd.title);
        row.addEventListener('click', () => this.renderDocumentDetail(rd));
      }
    }

    if (doc.remarks.length > 0) {
      const remarksDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
      remarksDiv.createDiv({ text: `📝 Замечания (${doc.remarks.length}):` });
      const remTable = remarksDiv.createEl('table', { cls: 'tn-table' });
      const remThead = remTable.createEl('thead');
      const remHeaderRow = remThead.createEl('tr');
      const remHeaders = ['№ п/п', 'Элемент', 'Текущая редакция', 'Предлагаемая редакция', 'Обоснование', 'Файлы', 'Автор'];
      for (const rh of remHeaders) remHeaderRow.createEl('th').setText(rh);
      const remTbody = remTable.createEl('tbody');
      for (let i = 0; i < doc.remarks.length; i++) {
        const r = doc.remarks[i];
        const row = remTbody.createEl('tr');
        row.createEl('td').setText(String(i + 1));
        row.createEl('td').setText(r.element_number || '—');
        row.createEl('td').setText(r.current_edition || '—');
        row.createEl('td').setText(r.proposed_edition || '—');
        row.createEl('td').setText(r.justification || '—');
        const fileCell = row.createEl('td');
        if (r.files && r.files.length > 0) {
          for (const f of r.files) {
            const a = fileCell.createEl('a', { attr: { href: '#' } });
            a.setText(f.file_name);
            a.addEventListener('click', (ev) => {
              ev.preventDefault();
              void this.downloadAndOpen(f.file_key, f.file_name || 'file');
            });
            fileCell.createEl('br');
          }
        } else {
          fileCell.setText('—');
        }
        row.createEl('td').setText(r.author_email || '—');
      }
    }

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });

    if (this.canEdit) {
      const attachBtn = btnRow.createEl('button', { text: '🔗 Привязать документы', cls: 'tn-btn tn-btn-ghost' });
      attachBtn.addEventListener('click', () => this.renderAttachPicker(doc));
      const relatedBtn = btnRow.createEl('button', { text: '➕ Связанный документ', cls: 'tn-btn tn-btn-ghost' });
      relatedBtn.addEventListener('click', () => this.showCreateForm(doc));
    }

    if (this.canComment) {
      const remarkBtn = btnRow.createEl('button', { text: '📝 Добавить замечание', cls: 'tn-btn tn-btn-ghost' });
      remarkBtn.addEventListener('click', () => this.showRemarkForm(doc));
    }

    if (this.canEdit && doc.completed) {
      const reopenBtn = btnRow.createEl('button', { text: '🔄 Возобновить', cls: 'tn-btn tn-btn-ghost' });
      reopenBtn.addEventListener('click', async () => {
        doc.completed = false;
        doc.sync_status = 'local';
        await this.plugin.documentsDb.save();
        new Notice('Документ возобновлён');
        this.renderDocumentDetail(doc);
      });
    } else if (this.canEdit) {
      const completeBtn = btnRow.createEl('button', { text: '✅ Завершить', cls: 'tn-btn tn-btn-ghost' });
      completeBtn.addEventListener('click', async () => {
        doc.completed = true;
        doc.sync_status = 'local';
        await this.plugin.documentsDb.save();
        new Notice('Документ завершён');
        this.renderDocumentDetail(doc);
      });
    }

    if (this.canEdit) {
      const editBtn = btnRow.createEl('button', { text: '✏️ Редактировать', cls: 'tn-btn tn-btn-ghost' });
      editBtn.addEventListener('click', () => this.showEditForm(doc));
    }

    if (this.canEdit && doc.parent_id > 0) {
      const detachBtn = btnRow.createEl('button', { text: '⤴ Отвязать (сделать самостоятельным)', cls: 'tn-btn tn-btn-ghost' });
      detachBtn.addEventListener('click', async () => {
        doc.parent_id = 0;
        doc.sync_status = 'local';
        doc.updated_at = new Date().toISOString();
        await this.plugin.documentsDb.save();
        new Notice('Документ отвязан');
        this.renderDocumentsView();
      });
    }
  }

  /** Таблица реквизитов реестра (только заполненные поля). */
  private renderRegistryDetail(doc: DocItem, container: HTMLElement): void {
    const fmt = (ms: number): string => (ms ? new Date(ms).toLocaleDateString() : '');
    const rows: Array<[string, string]> = [];
    if (doc.doc_number) rows.push(['№ документа', doc.doc_number]);
    if (doc.country) rows.push(['Страна', doc.country]);
    if (doc.valid_from) rows.push(['Начало действия', fmt(doc.valid_from)]);
    if (doc.deadline) rows.push(['Окончание действия', fmt(doc.deadline)]);
    if (doc.comment) rows.push(['Комментарий', doc.comment]);
    if (doc.responsible) rows.push(['Ответственный специалист', doc.responsible]);
    if (doc.product_group) rows.push(['Группа продукции', doc.product_group]);
    if (doc.trademark) rows.push(['Товарный знак', doc.trademark]);
    if (doc.manufacturer) rows.push(['Изготовитель', doc.manufacturer]);
    if (doc.tn_ved_code) rows.push(['Код ТН ВЭД', doc.tn_ved_code]);
    if (doc.testing_lab) rows.push(['Испытательная лаборатория', doc.testing_lab]);
    if (doc.protocol_number) rows.push(['№ протокола испытаний', doc.protocol_number]);
    if (doc.certification_body) rows.push(['Название ОС', doc.certification_body]);
    if (doc.ik_date) rows.push(['Дата ИК', fmt(doc.ik_date)]);
    if (rows.length === 0) return;

    const div = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
    div.createDiv({ text: '📋 Реквизиты реестра:' });
    const table = div.createEl('table', { cls: 'tn-table' });
    for (const [label, value] of rows) {
      const tr = table.createEl('tr');
      tr.createEl('th', { text: label }).addClass('tn-doc-detail-label');
      tr.createEl('td', { text: value }).addClass('tn-doc-detail-value');
    }
  }

  /** Пикер привязки существующих документов как связанных к текущему. */
  private renderAttachPicker(doc: DocItem): void {
    const container = this.bodyEl;
    const all = this.plugin.documentsDb.getAll();
    const ids = new Set(all.map(d => d.id));
    // Привязывать можно только «свободные» документы (собственные карточки).
    const attachable = all.filter(d => d.id !== doc.id && (d.parent_id <= 0 || !ids.has(d.parent_id)));
    const byId = (a: DocItem, b: DocItem): number => a.id - b.id;
    attachable.sort(byId);

    const picker = container.createDiv({ cls: 'tn-doc-card tn-doc-attach-picker' });
    picker.createEl('h4', { text: '🔗 Привязать документы' });
    const back = picker.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost tn-doc-mb8' });
    back.addEventListener('click', () => this.renderDocumentDetail(doc));

    if (attachable.length === 0) {
      picker.createDiv({ cls: 'tn-doc-meta' }).setText('Нет доступных документов для привязки');
      return;
    }

    const checks: HTMLInputElement[] = [];
    const list = picker.createDiv({ cls: 'tn-doc-attach-opts' });
    for (const d of attachable) {
      const wrapper = list.createEl('label', { cls: 'tn-doc-filter-label' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
      wrapper.createEl('span').setText(`${d.title}${d.doc_type ? ' — ' + d.doc_type : ''}`);
      checks.push(cb);
    }

    const okBtn = picker.createEl('button', { text: 'Привязать', cls: 'tn-btn tn-btn-primary tn-doc-mt12' });
    okBtn.addEventListener('click', async () => {
      const selected = attachable.filter((d, i) => checks[i].checked);
      if (selected.length === 0) {
        new Notice('Выберите документы для привязки');
        return;
      }
      const now = new Date().toISOString();
      for (const s of selected) {
        s.parent_id = doc.id;
        s.sync_status = 'local';
        s.updated_at = now;
        this.plugin.documentsDb.update(s.id, s);
      }
      await this.plugin.documentsDb.save();
      new Notice(`Привязано документов: ${selected.length}`);
      this.renderDocumentDetail(doc);
    });
    const cancelBtn = picker.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost tn-doc-mt12' });
    cancelBtn.addEventListener('click', () => this.renderDocumentDetail(doc));
  }

  // ---- Скачивание и открытие файлов ----

  /** Скачивает файл из S3 через сервис, сохраняет в хранилище вольта и открывает. */
  private async downloadAndOpen(fileKey: string, fileName: string): Promise<void> {
    try {
      const data = await this.plugin.syncService.downloadFile(fileKey);
      const dir = 'yourbase/sbe_documents/files';
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
      }
      const safeName = this.sanitizeFileName(fileName);
      const path = `${dir}/${safeName}`;
      await adapter.writeBinary(path, data);
      new Notice(`Файл «${safeName}» скачан в хранилище`);
      await this.openLocalFile(path, fileName);
    } catch (e: unknown) {
      new Notice(`Ошибка скачивания файла: ${errorMessage(e)}`);
    }
  }

  /** Открывает локальный файл: Obsidian (встроенные типы) или системное приложение. */
  private async openLocalFile(path: string, fileName: string): Promise<void> {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (OBSIDIAN_VIEWABLE.has(ext)) {
      await this.app.workspace.openLinkText(path, '');
      return;
    }
    try {
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) {
        new Notice(`Файл сохранён: ${path}`);
        return;
      }
      const fullPath = adapter.getFullPath(path);
      const { shell } = require('electron');
      const err = await shell.openPath(fullPath);
      if (err) {
        new Notice(`Не удалось открыть системным приложением: ${err}`);
      }
    } catch (e: unknown) {
      new Notice(`Файл сохранён: ${path} (${errorMessage(e)})`);
    }
  }

  private sanitizeFileName(name: string): string {
    const cleaned = (name || 'file').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
    return cleaned || 'file';
  }

  // ---- Формы ----

  /** Контролы полей реестра (колонки Excel) в форме. */
  private buildRegistryForm(container: HTMLElement, doc?: DocItem): RegistryControls {
    const c = {} as RegistryControls;
    const mkLabel = (text: string): void => {
      container.createEl('label', { text, cls: 'tn-doc-label' });
    };
    mkLabel('№ документа');
    c.docNumber = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Страна');
    c.country = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Начало действия');
    c.validFrom = container.createEl('input', { attr: { type: 'date' }, cls: 'tn-doc-input' });
    mkLabel('Комментарий');
    c.comment = container.createEl('textarea', { cls: 'tn-doc-textarea' });
    mkLabel('Ответственный специалист');
    c.responsible = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Группа продукции');
    c.productGroup = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Товарный знак');
    c.trademark = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Изготовитель');
    c.manufacturer = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Код ТН ВЭД');
    c.tnVedCode = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Испытательная лаборатория');
    c.testingLab = container.createEl('textarea', { cls: 'tn-doc-textarea' });
    mkLabel('№ протокола испытаний');
    c.protocolNumber = container.createEl('textarea', { cls: 'tn-doc-textarea' });
    mkLabel('Название ОС');
    c.certificationBody = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    mkLabel('Дата ИК');
    c.ikDate = container.createEl('input', { attr: { type: 'date' }, cls: 'tn-doc-input' });

    if (doc) {
      c.docNumber.value = doc.doc_number;
      c.country.value = doc.country;
      c.validFrom.value = doc.valid_from ? new Date(doc.valid_from).toISOString().slice(0, 10) : '';
      c.comment.value = doc.comment;
      c.responsible.value = doc.responsible;
      c.productGroup.value = doc.product_group;
      c.trademark.value = doc.trademark;
      c.manufacturer.value = doc.manufacturer;
      c.tnVedCode.value = doc.tn_ved_code;
      c.testingLab.value = doc.testing_lab;
      c.protocolNumber.value = doc.protocol_number;
      c.certificationBody.value = doc.certification_body;
      c.ikDate.value = doc.ik_date ? new Date(doc.ik_date).toISOString().slice(0, 10) : '';
    }
    return c;
  }

  /** Читает значения полей реестра из контролов формы. */
  private readRegistry(c: RegistryControls): {
    doc_number: string; country: string; valid_from: number; comment: string;
    responsible: string; product_group: string; trademark: string; manufacturer: string;
    tn_ved_code: string; testing_lab: string; protocol_number: string;
    certification_body: string; ik_date: number;
  } {
    const dateMs = (v: string): number => (v ? new Date(`${v}T23:59:59`).getTime() : 0);
    return {
      doc_number: c.docNumber.value.trim(),
      country: c.country.value.trim(),
      valid_from: dateMs(c.validFrom.value),
      comment: c.comment.value.trim(),
      responsible: c.responsible.value.trim(),
      product_group: c.productGroup.value.trim(),
      trademark: c.trademark.value.trim(),
      manufacturer: c.manufacturer.value.trim(),
      tn_ved_code: c.tnVedCode.value.trim(),
      testing_lab: c.testingLab.value.trim(),
      protocol_number: c.protocolNumber.value.trim(),
      certification_body: c.certificationBody.value.trim(),
      ik_date: dateMs(c.ikDate.value),
    };
  }

  private showCreateForm(parentDoc?: DocItem): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => parentDoc ? this.renderDocumentDetail(parentDoc) : this.renderDocumentsView());

    container.createEl('h3', { text: parentDoc ? `Связанный документ: ${parentDoc.title}` : '✉️ Новый документ' });

    const titleInput = container.createEl('input', {
      attr: { type: 'text', placeholder: 'Введите наименование документа' },
      cls: 'tn-doc-input',
    });

    const typeLabel = container.createEl('label', { text: 'Тип документа', cls: 'tn-doc-label' });
    const typeInput = container.createEl('input', {
      attr: { type: 'text', list: 'tn-doc-types' },
      cls: 'tn-doc-input',
    });
    this.renderDocTypeDatalist(typeInput);

    const typeRow = container.createDiv({ cls: 'tn-doc-flex tn-doc-mb12' });
    const addTypeBtn = typeRow.createEl('button', { text: '➕ Создать тип документа', cls: 'tn-btn tn-btn-ghost' });
    addTypeBtn.addEventListener('click', () => this.createDocTypeFromField(typeInput));

    const curatorLabel = container.createEl('label', { text: 'Куратор (email)', cls: 'tn-doc-label' });
    const curatorInput = container.createEl('input', {
      attr: { type: 'text', placeholder: 'polishchuk@tn.ru' },
      cls: 'tn-doc-input',
    });
    curatorInput.value = this.plugin.settings.defaultAuthor;

    const deadlineLabel = container.createEl('label', { text: 'Срок действия', cls: 'tn-doc-label' });
    const deadlineInput = container.createEl('input', { attr: { type: 'date' }, cls: 'tn-doc-input' });

    const reg = this.buildRegistryForm(container);

    const fileLabel = container.createEl('label', { text: 'Файл документа', cls: 'tn-doc-label' });
    const fileInput = container.createEl('input', { attr: { type: 'file' }, cls: 'tn-doc-mb8' });
    const fileNameDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb8' });

    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) fileNameDiv.setText(`📎 ${fileInput.files[0].name}`);
    });

    const linkLabel = container.createEl('label', { text: 'Ссылка на документ (если без файла)', cls: 'tn-doc-label' });
    const linkInput = container.createEl('input', { attr: { type: 'url', placeholder: 'https://...' }, cls: 'tn-doc-input' });

    // Привязка существующих документов как связанных к новому (только при создании
    // самостоятельного документа; для связанного — используйте «🔗 Привязать документы»).
    const attachChecks: HTMLInputElement[] = [];
    let attachable: DocItem[] = [];
    if (!parentDoc) {
      const attachLabel = container.createEl('label', { text: '🔗 Привязать существующие документы (станут связанными)', cls: 'tn-doc-label' });
      const all = this.plugin.documentsDb.getAll();
      const ids = new Set(all.map(d => d.id));
      attachable = all.filter(d => d.parent_id <= 0 || !ids.has(d.parent_id));
      const byId = (a: DocItem, b: DocItem): number => a.id - b.id;
      attachable.sort(byId);
      const attachDiv = container.createDiv({ cls: 'tn-doc-attach-opts tn-doc-mb12' });
      if (attachable.length > 0) {
        for (const d of attachable) {
          const wrapper = attachDiv.createEl('label', { cls: 'tn-doc-filter-label' });
          const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
          wrapper.createEl('span').setText(`${d.title}${d.doc_type ? ' — ' + d.doc_type : ''}`);
          attachChecks.push(cb);
        }
      } else {
        attachDiv.createDiv({ cls: 'tn-doc-meta' }).setText('Нет документов для привязки');
      }
    }

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => parentDoc ? this.renderDocumentDetail(parentDoc) : this.renderDocumentsView());

    saveBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) { new Notice('Введите наименование документа'); return; }

      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      try {
        let fileData: { key: string; name: string; size: number; url: string } | null = null;
        if (fileInput.files?.[0]) {
          const file = fileInput.files[0];
          const buf = await file.arrayBuffer();
          const res = await this.plugin.syncService.uploadFile(buf, file.name);
          fileData = { key: res.file_key, name: res.file_name, size: res.file_size, url: res.file_url };
        }

        const now = new Date().toISOString();
        const deadlineVal = deadlineInput.value;
        const deadlineMs = deadlineVal ? new Date(`${deadlineVal}T23:59:59`).getTime() : 0;
        const linkUrl = linkInput.value.trim();
        const regVals = this.readRegistry(reg);

        const docItem: DocItem = {
          id: Date.now() + Math.floor(Math.random() * 1000),
          title,
          doc_type: typeInput.value.trim(),
          curator_email: curatorInput.value.trim() || this.plugin.settings.defaultAuthor,
          deadline: deadlineMs,
          file_key: fileData?.key || '',
          file_name: fileData?.name || '',
          file_size: fileData?.size || 0,
          file_url: fileData?.url || '',
          link_url: parentDoc ? '' : linkUrl,
          link_file_name: parentDoc ? '' : (fileData?.name || ''),
          parent_id: parentDoc ? parentDoc.id : 0,
          completed: false,
          remarks: [],
          country: regVals.country,
          doc_number: regVals.doc_number,
          valid_from: regVals.valid_from,
          comment: regVals.comment,
          responsible: regVals.responsible,
          product_group: regVals.product_group,
          trademark: regVals.trademark,
          manufacturer: regVals.manufacturer,
          tn_ved_code: regVals.tn_ved_code,
          testing_lab: regVals.testing_lab,
          protocol_number: regVals.protocol_number,
          certification_body: regVals.certification_body,
          ik_date: regVals.ik_date,
          created_at: now,
          updated_at: now,
          sync_status: 'local',
        };

        this.plugin.documentsDb.add(docItem);
        const attachNow = new Date().toISOString();
        attachChecks.forEach((cb, i) => {
          if (cb.checked) {
            const target = attachable[i];
            target.parent_id = docItem.id;
            target.sync_status = 'local';
            target.updated_at = attachNow;
            this.plugin.documentsDb.update(target.id, target);
          }
        });
        await this.plugin.documentsDb.save();
        new Notice('Документ сохранён (будет отправлен на сервер при синхронизации)');
        this.renderDocumentsView();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Сохранить');
        saveBtn.removeAttribute('disabled');
        cancelBtn.removeAttribute('disabled');
      }
    });
  }

  private showEditForm(doc: DocItem): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderDocumentDetail(doc));

    container.createEl('h3', { text: `✏️ Редактировать: ${doc.title}` });

    const titleInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    titleInput.value = doc.title;

    const typeLabel = container.createEl('label', { text: 'Тип документа', cls: 'tn-doc-label' });
    const typeInput = container.createEl('input', {
      attr: { type: 'text', list: 'tn-doc-types' },
      cls: 'tn-doc-input',
    });
    typeInput.value = doc.doc_type;
    this.renderDocTypeDatalist(typeInput);

    const typeRow = container.createDiv({ cls: 'tn-doc-flex tn-doc-mb12' });
    const addTypeBtn = typeRow.createEl('button', { text: '➕ Создать тип документа', cls: 'tn-btn tn-btn-ghost' });
    addTypeBtn.addEventListener('click', () => this.createDocTypeFromField(typeInput));

    const curatorLabel = container.createEl('label', { text: 'Куратор (email)', cls: 'tn-doc-label' });
    const curatorInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-doc-input' });
    curatorInput.value = doc.curator_email;

    const deadlineLabel = container.createEl('label', { text: 'Срок действия', cls: 'tn-doc-label' });
    const deadlineInput = container.createEl('input', { attr: { type: 'date' }, cls: 'tn-doc-input' });
    deadlineInput.value = doc.deadline ? new Date(doc.deadline).toISOString().slice(0, 10) : '';

    const reg = this.buildRegistryForm(container, doc);

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderDocumentDetail(doc));

    saveBtn.addEventListener('click', async () => {
      const title = titleInput.value.trim();
      if (!title) { new Notice('Введите наименование документа'); return; }
      const deadlineVal = deadlineInput.value;
      const deadlineMs = deadlineVal ? new Date(`${deadlineVal}T23:59:59`).getTime() : 0;
      doc.title = title;
      doc.doc_type = typeInput.value.trim();
      doc.curator_email = curatorInput.value.trim();
      doc.deadline = deadlineMs;
      const regVals = this.readRegistry(reg);
      doc.doc_number = regVals.doc_number;
      doc.country = regVals.country;
      doc.valid_from = regVals.valid_from;
      doc.comment = regVals.comment;
      doc.responsible = regVals.responsible;
      doc.product_group = regVals.product_group;
      doc.trademark = regVals.trademark;
      doc.manufacturer = regVals.manufacturer;
      doc.tn_ved_code = regVals.tn_ved_code;
      doc.testing_lab = regVals.testing_lab;
      doc.protocol_number = regVals.protocol_number;
      doc.certification_body = regVals.certification_body;
      doc.ik_date = regVals.ik_date;
      doc.sync_status = 'local';
      doc.updated_at = new Date().toISOString();
      this.plugin.documentsDb.update(doc.id, doc);
      await this.plugin.documentsDb.save();
      new Notice('Документ обновлён');
      this.renderDocumentDetail(doc);
    });
  }

  private showRemarkForm(doc: DocItem): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderDocumentDetail(doc));

    container.createEl('h3', { text: `Замечания к документу: ${doc.title}` });

    const elemInput = this.labeledInput(container, 'Номер структурного элемента', 'Например: 1.2.3');
    const curInput = this.labeledTextarea(container, 'Текущая редакция');
    const propInput = this.labeledTextarea(container, 'Предлагаемая редакция');
    const justInput = this.labeledTextarea(container, 'Обоснование изменений');

    const fileLabel = container.createEl('label', { text: 'Прикрепить файл к замечанию', cls: 'tn-doc-label' });
    const fileInput = container.createEl('input', { attr: { type: 'file' }, cls: 'tn-doc-mb8' });

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить замечание', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderDocumentDetail(doc));

    saveBtn.addEventListener('click', async () => {
      const elementNumber = elemInput.value.trim();
      const currentEdition = curInput.value.trim();
      const proposedEdition = propInput.value.trim();
      const justification = justInput.value.trim();
      if (!elementNumber && !currentEdition && !proposedEdition && !justification) {
        new Notice('Заполните хотя бы одно поле'); return;
      }

      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      try {
        const files: DocumentRemark['files'] = [];
        if (fileInput.files?.[0]) {
          const file = fileInput.files[0];
          const buf = await file.arrayBuffer();
          const res = await this.plugin.syncService.uploadRemarkFile(buf, file.name, doc.id);
          files.push({ file_key: res.file_key, file_name: res.file_name, file_size: res.file_size, file_url: res.file_url });
        }

        doc.remarks.push({
          element_number: elementNumber,
          current_edition: currentEdition,
          proposed_edition: proposedEdition,
          justification,
          files,
          author_email: this.plugin.settings.defaultAuthor,
        });
        doc.sync_status = 'local';
        doc.updated_at = new Date().toISOString();
        await this.plugin.documentsDb.save();
        new Notice('Замечание сохранено');
        this.renderDocumentDetail(doc);
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Сохранить замечание');
        saveBtn.removeAttribute('disabled');
        cancelBtn.removeAttribute('disabled');
      }
    });
  }

  private labeledInput(container: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    container.createEl('label', { text: label, cls: 'tn-doc-label' });
    return container.createEl('input', { attr: { type: 'text', placeholder }, cls: 'tn-doc-input' });
  }

  private labeledTextarea(container: HTMLElement, label: string): HTMLTextAreaElement {
    container.createEl('label', { text: label, cls: 'tn-doc-label' });
    return container.createEl('textarea', { cls: 'tn-doc-textarea' });
  }

  private renderDocTypeDatalist(input: HTMLElement): void {
    const list = 'tn-doc-types';
    const existing = document.getElementById(list);
    if (existing) existing.remove();
    const datalist = document.createElement('datalist');
    datalist.id = list;
    for (const t of this.plugin.documentsDb.getDocTypes()) {
      datalist.createEl('option', { value: t });
    }
    document.body.appendChild(datalist);
  }

  /** Добавляет тип документа из введённого имени (если ещё нет) и обновляет datalist. */
  private async createDocTypeFromField(typeInput: HTMLInputElement): Promise<void> {
    const name = typeInput.value.trim();
    if (!name) {
      new Notice('Введите название типа документа');
      typeInput.focus();
      return;
    }
    const added = this.plugin.documentsDb.addDocType(name);
    await this.plugin.documentsDb.save();
    this.renderDocTypeDatalist(typeInput);
    this.renderSidebarFilters();
    if (added) {
      new Notice(`Тип документа «${name}» создан`);
    } else {
      new Notice(`Тип документа «${name}» уже существует`);
    }
  }

  private async exportHtml(): Promise<void> {
    const docs = this.plugin.documentsDb.getAll();
    const rows = docs.map((d, i) => {
      const deadlineStr = d.deadline ? new Date(d.deadline).toLocaleDateString() : '';
      const link = d.file_url || d.link_url;
      const linkHtml = link ? `<a href="${this.escapeHtml(link)}">${this.escapeHtml(d.file_name || d.link_file_name || 'Ссылка')}</a>` : '';
      return `<tr><td style="text-align:center">${i + 1}</td><td>${this.escapeHtml(d.title)}</td><td>${this.escapeHtml(d.doc_type)}</td><td style="text-align:center">${deadlineStr}</td><td>${this.escapeHtml(d.curator_email)}</td><td style="text-align:center">${linkHtml}</td></tr>`;
    }).join('\n');
    const html = `<table style="width:724px;border-collapse:collapse" border="1" cellpadding="5"><thead><tr style="background:#f8cac6"><th>№</th><th>Наименование</th><th>Тип</th><th>Срок</th><th>Куратор</th><th>Файл</th></tr></thead><tbody>${rows}</tbody></table>`;
    try {
      await navigator.clipboard.writeText(html);
      new Notice(`✅ Скопировано ${docs.length} строк в буфер обмена`);
    } catch (e: unknown) {
      new Notice(`❌ Не удалось скопировать: ${errorMessage(e)}`);
    }
  }

  /** Экспорт текущего отфильтрованного набора документов в .xlsx (без зависимостей).
   *  В колонке «Файл/Ссылка» — временные веб-ссылки на файлы (presigned S3) как
   *  кликабельные гиперссылки. */
  private async exportExcel(): Promise<void> {
    const docs = this.getVisibleRoots();
    if (docs.length === 0) {
      new Notice('Нет документов для экспорта');
      return;
    }
    const header = [
      '№', 'Название продукции', 'Тип документа', 'Страна', '№ документа',
      'Начало действия', 'Окончание действия', 'Комментарий', 'Ответственный специалист',
      'Группа продукции', 'Товарный знак', 'Изготовитель', 'Код ТН ВЭД',
      'Испытательная лаборатория', '№ протокола испытаний', 'Название ОС', 'Дата ИК',
      'Файл/Ссылка',
    ];
    new Notice(`Готовлю ссылки на файлы (${docs.length} документов)…`);
    const rows: string[][] = new Array(docs.length);
    const links: Array<{ cell: string; url: string }> = [];
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < docs.length) {
        const i = idx++;
        const d = docs[i];
        let link = '';
        if (d.file_key) {
          try {
            link = await this.plugin.syncService.getFileLink(d.file_key);
          } catch (e: unknown) {
            console.warn(`Документы: не удалось получить ссылку на файл «${d.file_name}»:`, errorMessage(e));
          }
        } else if (d.link_url) {
          link = d.link_url;
        }
        rows[i] = this.exportRow(d, i + 1, link);
        if (link) links.push({ cell: `R${i + 2}`, url: link });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const data = buildXlsx(header, rows, links);
    try {
      const dir = 'yourbase/sbe_documents/exports';
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) {
        await adapter.mkdir(dir);
      }
      const stamp = new Date().toISOString().slice(0, 10);
      const fileName = `Реестр_${stamp}.xlsx`;
      const path = `${dir}/${fileName}`;
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await adapter.writeBinary(path, buf);
      new Notice(`Экспортировано строк: ${rows.length}`);
      await this.openLocalFile(path, fileName);
    } catch (e: unknown) {
      new Notice(`Ошибка экспорта: ${errorMessage(e)}`);
    }
  }

  /** Строка экспорта реестра по документу. fileLink — веб-ссылка на файл. */
  private exportRow(d: DocItem, index: number, fileLink: string): string[] {
    const fmt = (ms: number): string => (ms ? new Date(ms).toLocaleDateString('ru-RU') : '');
    return [
      String(index), d.title || '', d.doc_type || '', d.country || '', d.doc_number || '',
      fmt(d.valid_from), fmt(d.deadline), d.comment || '', d.responsible || '',
      d.product_group || '', d.trademark || '', d.manufacturer || '', d.tn_ved_code || '',
      d.testing_lab || '', d.protocol_number || '', d.certification_body || '', fmt(d.ik_date),
      fileLink || d.link_url || '',
    ];
  }

  /** Импорт реестра сертификатов из sert/Реестр сертификатов TN1.json. */
  private async importRegistry(): Promise<void> {
    if (!this.canEdit) return;
    const ok = window.confirm('Импортировать реестр сертификатов из файла «sert/Реестр сертификатов TN1.json»?\nУже добавленные ранее записи будут пропущены.');
    if (!ok) return;
    try {
      const result = await this.plugin.importSertRegistry();
      new Notice(`Импорт реестра: добавлено ${result.added}, пропущено ${result.skipped}; с файлами — ${result.withFile}, без файла — ${result.noFile}`);
      this.renderSidebarFilters();
      this.renderSidebarCountryFilters();
      await this.syncAndRender();
    } catch (e: unknown) {
      new Notice(`Ошибка импорта: ${errorMessage(e)}`);
    }
  }

  private escapeHtml(text: string): string {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async syncAndRender(): Promise<void> {
    try {
      await this.plugin.syncService.sync();
      this.renderSidebarFilters();
      this.renderSidebarCountryFilters();
      this.renderDocumentsView();
    } catch (e: unknown) {
      new Notice(`Документы: синхронизация не выполнена — ${errorMessage(e)}`);
      this.renderDocumentsView();
    }
  }
}