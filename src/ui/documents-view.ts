import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeDocumentsPlugin from '../main';
import type { DocItem, DocumentRemark } from '../types/documents';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_DOCUMENTS_VIEW_TYPE = 'sbe-documents-view';

export class DocumentsView extends ItemView {
  plugin: SbeDocumentsPlugin;
  private containerElContent!: HTMLElement;
  private selectedDocTypes: Set<string> = new Set();
  private searchQuery = '';
  private searchTimeout: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SbeDocumentsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_DOCUMENTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Документы';
  }

  getIcon(): string {
    return 'file-text';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-doc-container');
    this.containerElContent = container.createDiv();
    await this.syncAndRender();
  }

  refresh(): void {
    this.renderView();
  }

  private renderView(): void {
    const container = this.containerElContent;
    container.empty();

    const header = container.createDiv({ cls: 'tn-doc-header' });
    header.createEl('h3', { text: '📄 Документы' });
    const createBtn = header.createEl('button', { text: '➕ Добавить документ', cls: 'tn-btn tn-btn-primary' });
    createBtn.addEventListener('click', () => this.showCreateForm());
    const syncBtn = header.createEl('button', { text: '🔄', cls: 'tn-btn tn-btn-ghost' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });
    const exportBtn = header.createEl('button', { text: '📄 Экспорт HTML', cls: 'tn-btn tn-btn-ghost' });
    exportBtn.addEventListener('click', () => { void this.exportHtml(); });

    const searchInput = container.createEl('input', {
      attr: { type: 'text', placeholder: '🔍 Поиск по названию...' },
      cls: 'tn-doc-input tn-doc-mb8',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderView(), 400);
    });

    const docTypes = this.plugin.documentsDb.getDocTypes();
    if (docTypes.length > 0) {
      const filterDiv = container.createDiv({ cls: 'tn-doc-filters tn-doc-mb8' });
      filterDiv.createDiv({ text: 'Типы:', cls: 'tn-doc-meta' });
      for (const t of docTypes) {
        const wrapper = filterDiv.createEl('label', { cls: 'tn-doc-filter-label' });
        const cb = wrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-doc-cb' });
        cb.checked = this.selectedDocTypes.has(t);
        cb.addEventListener('change', () => {
          if (cb.checked) this.selectedDocTypes.add(t);
          else this.selectedDocTypes.delete(t);
          this.renderView();
        });
        wrapper.createEl('span').setText(` ${t}`);
      }
    }

    let docs = this.plugin.documentsDb.getAll();
    const q = this.searchQuery.trim().toLowerCase();
    if (q) docs = docs.filter(d => d.title.toLowerCase().includes(q));
    if (this.selectedDocTypes.size > 0) docs = docs.filter(d => this.selectedDocTypes.has(d.doc_type));
    docs.sort((a, b) => (b.deadline || 0) - (a.deadline || 0));

    const table = container.createEl('table', { cls: 'tn-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers = ['Наименование', 'Тип документа', 'Куратор', 'Срок действия', 'Файл', 'Статус'];
    for (const h of headers) headerRow.createEl('th').setText(h);

    const tbody = table.createEl('tbody');
    if (docs.length === 0) {
      const emptyRow = tbody.createEl('tr');
      const td = emptyRow.createEl('td', { cls: 'tn-doc-center tn-doc-p24' });
      td.setAttr('colspan', '6');
      td.setText('Нет документов');
      return;
    }

    for (const doc of docs) {
      const row = tbody.createEl('tr', { cls: 'tn-doc-row' });
      row.addEventListener('click', () => this.renderDocumentDetail(doc));

      row.createEl('td').setText(doc.title);
      row.createEl('td').setText(doc.doc_type || '—');
      row.createEl('td').setText(doc.curator_email || '—');

      const deadlineCell = row.createEl('td');
      if (doc.deadline) {
        deadlineCell.setText(new Date(doc.deadline).toLocaleDateString());
        const daysLeft = Math.ceil((doc.deadline - Date.now()) / 86400000);
        if (doc.completed) {
          deadlineCell.addClass('tn-doc-green');
        } else if (daysLeft < 0) {
          deadlineCell.addClass('tn-doc-red');
          deadlineCell.addClass('tn-doc-bold');
        } else if (daysLeft <= 7) {
          deadlineCell.addClass('tn-doc-orange');
        } else {
          deadlineCell.addClass('tn-doc-green');
        }
      } else {
        deadlineCell.setText('—');
      }

      const fileCell = row.createEl('td');
      if (doc.file_url || doc.link_url) {
        const label = doc.file_name || doc.link_file_name || 'Ссылка';
        fileCell.setText(label);
        fileCell.addClass('tn-doc-link');
      } else {
        fileCell.setText('—');
      }

      const statusCell = row.createEl('td');
      statusCell.setText(doc.completed ? '✅ Завершён' : '🟢 Активен');
    }
  }

  private renderDocumentDetail(doc: DocItem): void {
    const container = this.containerElContent;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: doc.title });

    const meta = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
    meta.createDiv({ text: `📂 Тип документа: ${doc.doc_type || '—'}` });
    meta.createDiv({ text: `👤 Куратор: ${doc.curator_email || '—'}` });
    if (doc.deadline) meta.createDiv({ text: `📅 Срок действия: ${new Date(doc.deadline).toLocaleDateString()}` });
    meta.createDiv({ text: `✅ Статус: ${doc.completed ? 'Завершён' : 'Активен'}` });

    if (doc.file_url) {
      const linkDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb12' });
      linkDiv.createDiv({ text: 'Файл документа:' });
      const a = linkDiv.createEl('a', { href: doc.file_url, attr: { target: '_blank' } });
      a.setText(doc.file_name || 'Скачать');
      const ext = (doc.file_name || '').toLowerCase().split('.').pop() || '';
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext);
      if (isImage) {
        linkDiv.createEl('br');
        linkDiv.createEl('img', { attr: { src: doc.file_url, alt: doc.file_name } }).addClass('tn-doc-img');
      }
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
            fileCell.createEl('a', { href: f.file_url, attr: { target: '_blank' } }).setText(f.file_name);
            fileCell.createEl('br');
          }
        } else {
          fileCell.setText('—');
        }
        row.createEl('td').setText(r.author_email || '—');
      }
    }

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });

    const relatedBtn = btnRow.createEl('button', { text: '🔗 Связанный документ', cls: 'tn-btn tn-btn-ghost' });
    relatedBtn.addEventListener('click', () => this.showCreateRelatedForm(doc));

    const remarkBtn = btnRow.createEl('button', { text: '📝 Добавить замечание', cls: 'tn-btn tn-btn-ghost' });
    remarkBtn.addEventListener('click', () => this.showRemarkForm(doc));

    if (doc.completed) {
      const reopenBtn = btnRow.createEl('button', { text: '🔄 Возобновить', cls: 'tn-btn tn-btn-ghost' });
      reopenBtn.addEventListener('click', async () => {
        doc.completed = false;
        doc.sync_status = 'local';
        await this.plugin.documentsDb.save();
        new Notice('Документ возобновлён');
        this.renderDocumentDetail(doc);
      });
    } else {
      const completeBtn = btnRow.createEl('button', { text: '✅ Завершить', cls: 'tn-btn tn-btn-ghost' });
      completeBtn.addEventListener('click', async () => {
        doc.completed = true;
        doc.sync_status = 'local';
        await this.plugin.documentsDb.save();
        new Notice('Документ завершён');
        this.renderDocumentDetail(doc);
      });
    }

    const editBtn = btnRow.createEl('button', { text: '✏️ Редактировать', cls: 'tn-btn tn-btn-ghost' });
    editBtn.addEventListener('click', () => this.showEditForm(doc));
  }

  private showCreateForm(parentDoc?: DocItem): void {
    const container = this.containerElContent;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => parentDoc ? this.renderDocumentDetail(parentDoc) : this.renderView());

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

    const fileLabel = container.createEl('label', { text: 'Файл документа', cls: 'tn-doc-label' });
    const fileInput = container.createEl('input', { attr: { type: 'file' }, cls: 'tn-doc-mb8' });
    const fileNameDiv = container.createDiv({ cls: 'tn-doc-meta tn-doc-mb8' });

    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) fileNameDiv.setText(`📎 ${fileInput.files[0].name}`);
    });

    const linkLabel = container.createEl('label', { text: 'Ссылка на документ (если без файла)', cls: 'tn-doc-label' });
    const linkInput = container.createEl('input', { attr: { type: 'url', placeholder: 'https://...' }, cls: 'tn-doc-input' });

    const btnRow = container.createDiv({ cls: 'tn-doc-header tn-doc-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => parentDoc ? this.renderDocumentDetail(parentDoc) : this.renderView());

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
          created_at: now,
          updated_at: now,
          sync_status: 'local',
        };

        this.plugin.documentsDb.add(docItem);
        await this.plugin.documentsDb.save();
        new Notice('Документ сохранён (будет отправлен на сервер при синхронизации)');
        this.renderView();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Сохранить');
        saveBtn.removeAttribute('disabled');
        cancelBtn.removeAttribute('disabled');
      }
    });
  }

  private showCreateRelatedForm(parentDoc: DocItem): void {
    this.showCreateForm(parentDoc);
  }

  private showEditForm(doc: DocItem): void {
    const container = this.containerElContent;
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
      doc.sync_status = 'local';
      doc.updated_at = new Date().toISOString();
      this.plugin.documentsDb.update(doc.id, doc);
      await this.plugin.documentsDb.save();
      new Notice('Документ обновлён');
      this.renderDocumentDetail(doc);
    });
  }

  private showRemarkForm(doc: DocItem): void {
    const container = this.containerElContent;
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

  private escapeHtml(text: string): string {
    return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async syncAndRender(): Promise<void> {
    try {
      await this.plugin.syncService.sync();
      this.renderView();
    } catch (e: unknown) {
      new Notice(`Документы: синхронизация не выполнена — ${errorMessage(e)}`);
      this.renderView();
    }
  }
}
