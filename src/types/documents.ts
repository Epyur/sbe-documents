/** Типы модуля документов SBE. Модель совместима с documents-service (server_back/documents-service). */

export interface DocumentRemarkFile {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
}

export interface DocumentRemark {
  element_number: string;
  current_edition: string;
  proposed_edition: string;
  justification: string;
  files: DocumentRemarkFile[];
  author_email: string;
}

/** Документ. Поле updated_at — для LWW (сервер авторитетен). */
export interface DocItem {
  id: number;
  title: string;
  doc_type: string;
  curator_email: string;
  deadline: number;
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
  link_url: string;
  link_file_name: string;
  parent_id: number;
  completed: boolean;
  remarks: DocumentRemark[];
  created_at: string;
  updated_at: string;
  sync_status: 'local' | 'synced';
  /** Страна (колонка «Страна» реестра). */
  country: string;
  /** № документа (колонка «№ документа» реестра). */
  doc_number: string;
  /** Начало действия, мс (0 = нет). */
  valid_from: number;
  /** Комментарий (колонка «Комментарий»). */
  comment: string;
  /** Ответственный специалист (имя, колонка «Ответственный специалист»). */
  responsible: string;
  /** Группа продукции. */
  product_group: string;
  /** Товарный знак. */
  trademark: string;
  /** Изготовитель. */
  manufacturer: string;
  /** Код ТН ВЭД. */
  tn_ved_code: string;
  /** Название испытательной лаборатории. */
  testing_lab: string;
  /** № протокола испытаний. */
  protocol_number: string;
  /** Название ОС (орган по сертификации). */
  certification_body: string;
  /** Дата ИК (инспекционный контроль), мс (0 = нет). */
  ik_date: number;
  /** В архиве (ручной архив куратора/админа или автоматический по истечении срока). */
  archived: boolean;
}

export interface DocumentsDbData {
  documents: DocItem[];
  doc_types: string[];
}

/** Ответ сервера на pull — массив документов. */
export interface PullResponse {
  documents: DocItem[];
}

/** Ответ сервера на push — количество вставленных/обновлённых. */
export interface PushResponse {
  inserted: number;
  updated: number;
}

/** Ответ сервера на загрузку файла. */
export interface UploadFileResponse {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
}

/** Легаси-задача YouGile с description типа document (для миграции). */
export interface LegacyDocTask {
  id: string;
  title: string;
  columnId: string;
  completed: boolean;
  assigned: string[];
  deadline?: number;
  description: string;
}
