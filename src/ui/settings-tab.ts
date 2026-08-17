import { App, PluginSettingTab, Setting } from 'obsidian';
import type SbeDocumentsPlugin from '../main';

export class DocumentsSettingsTab extends PluginSettingTab {
  plugin: SbeDocumentsPlugin;

  constructor(app: App, plugin: SbeDocumentsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName('Сервер');

    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL documents-service, например https://epyur.fvds.ru. JWT берётся из ЦУП СБЕ — отдельный токен не нужен.')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Документы');

    new Setting(containerEl)
      .setName('Куратор по умолчанию')
      .setDesc('Подставляется в поле «Куратор» при создании нового документа.')
      .addText(text => text
        .setPlaceholder('И.И. Иванов')
        .setValue(this.plugin.settings.defaultAuthor)
        .onChange(async (value) => {
          this.plugin.settings.defaultAuthor = value.trim();
          await this.plugin.saveSettings();
        }));
  }
}
