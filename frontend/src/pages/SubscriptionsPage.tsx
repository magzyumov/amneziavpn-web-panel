import React, { useState, useEffect, useRef } from 'react';
import { subscriptionsApi } from '../api';

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button className={`btn btn-sm ${copied ? 'btn-primary' : 'btn-outline'}`} onClick={copy}>
      {copied ? '✓ Copied' : label}
    </button>
  );
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState([]);
  const [template, setTemplate] = useState('');
  const [originalTemplate, setOriginalTemplate] = useState('');
  const [vpsHost, setVpsHost] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [msg, setMsg] = useState(null);
  const [activeTab, setActiveTab] = useState('subs'); // 'subs' | 'template' | 'settings'
  const textareaRef = useRef();

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [subsR, templateR, settingsR] = await Promise.all([
        subscriptionsApi.list(),
        subscriptionsApi.getTemplate(),
        subscriptionsApi.getSettings(),
      ]);
      setSubs(subsR.data);
      setTemplate(templateR.data.template);
      setOriginalTemplate(templateR.data.template);
      setVpsHost(settingsR.data.vpsHost || '');
    } finally {
      setLoading(false);
    }
  };

  const showMsg = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 3000);
  };

  const saveTemplate = async () => {
    setSaving(true);
    try {
      await subscriptionsApi.saveTemplate(template);
      setOriginalTemplate(template);
      showMsg('Шаблон сохранён');
    } catch (e) {
      showMsg(e.response?.data?.error || 'Ошибка', 'error');
    } finally {
      setSaving(false);
    }
  };

  const resetTemplate = async () => {
    if (!confirm('Сбросить шаблон к дефолтному?')) return;
    const r = await subscriptionsApi.resetTemplate();
    setTemplate(r.data.template);
    setOriginalTemplate(r.data.template);
    showMsg('Шаблон сброшен');
  };

  const regenerate = async () => {
    setRegenerating(true);
    try {
      const r = await subscriptionsApi.regenerate();
      showMsg(`Обновлено подписок: ${r.data.updated}`);
    } catch (e) {
      showMsg('Ошибка при обновлении', 'error');
    } finally {
      setRegenerating(false);
    }
  };

  const saveSettings = async () => {
    await subscriptionsApi.saveSettings({ vpsHost });
    showMsg('Настройки сохранены');
  };

  const deleteSub = async (id) => {
    if (!confirm('Удалить подписку?')) return;
    await subscriptionsApi.delete(id);
    setSubs(s => s.filter(x => x.id !== id));
  };

  const isTemplateChanged = template !== originalTemplate;

  return (
    <>
      <div className="page-header">
        <div className="flex items-center justify-between">
          <div>
            <div className="page-title">Подписки</div>
            <div className="page-sub">// FLClash / Clash Meta subscription management</div>
          </div>
        </div>
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginTop: 16 }}>
          {[
            { id: 'subs', label: `Подписки (${subs.length})` },
            { id: 'template', label: 'Шаблон' },
            { id: 'settings', label: 'Настройки' },
          ].map(t => (
            <button
              key={t.id}
              className={`btn btn-sm ${activeTab === t.id ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              {t.id === 'template' && isTemplateChanged && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--yellow)', display: 'inline-block', marginLeft: 6 }} />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="page-body">
        {msg && (
          <div className={`notice ${msg.type === 'error' ? 'notice-error' : 'notice-success'}`} style={{ marginBottom: 16 }}>
            {msg.text}
          </div>
        )}

        {/* ── Список подписок ─────────────────────────────────────── */}
        {activeTab === 'subs' && (
          loading ? (
            <div style={{ textAlign: 'center', padding: 48 }}><span className="spinner" style={{ width: 24, height: 24 }} /></div>
          ) : subs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📡</div>
              <div className="empty-text">Нет подписок. Создайте Xray клиента — подписка появится автоматически.</div>
            </div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Сервер</th>
                    <th>URL подписки</th>
                    <th>Создан</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map(sub => {
                    const subUrl = subscriptionsApi.subUrl(sub.slug);
                    return (
                      <tr key={sub.id}>
                        <td style={{ fontWeight: 500 }}>{sub.client_name}</td>
                        <td className="mono text-dim" style={{ fontSize: 12 }}>{sub.server_host}</td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="mono text-muted" style={{ fontSize: 11, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {subUrl}
                            </span>
                            <CopyButton text={subUrl} label="📋 Copy URL" />
                          </div>
                        </td>
                        <td className="mono text-muted" style={{ fontSize: 11 }}>
                          {new Date(sub.created_at).toLocaleDateString('ru-RU')}
                        </td>
                        <td>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteSub(sub.id)}>✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* ── Редактор шаблона ────────────────────────────────────── */}
        {activeTab === 'template' && (
          <div>
            <div className="notice notice-info" style={{ marginBottom: 16 }}>
              Шаблон — Clash YAML. Используйте <code style={{ background: 'var(--surface3)', padding: '1px 6px', borderRadius: 3 }}>PROXIES_PLACEHOLDER</code> для вставки прокси и <code style={{ background: 'var(--surface3)', padding: '1px 6px', borderRadius: 3 }}>PROXY_NAME_PLACEHOLDER</code> для имени ноды в proxy-groups.
            </div>

            <div className="card">
              <div className="flex justify-between items-center" style={{ marginBottom: 12 }}>
                <span className="card-title" style={{ margin: 0 }}>Clash YAML Template</span>
                <div className="flex gap-8">
                  {isTemplateChanged && (
                    <span className="mono" style={{ fontSize: 11, color: 'var(--yellow)', alignSelf: 'center' }}>● Несохранённые изменения</span>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={resetTemplate}>↺ Сбросить</button>
                  <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={regenerating}>
                    {regenerating ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⟳ Обновить все подписки'}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={saveTemplate} disabled={saving || !isTemplateChanged}>
                    {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '💾 Сохранить'}
                  </button>
                </div>
              </div>

              <textarea
                ref={textareaRef}
                className="input input-mono"
                style={{
                  minHeight: 480,
                  fontSize: 12,
                  lineHeight: 1.6,
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                  background: '#010409',
                  color: '#7ee787',
                }}
                value={template}
                onChange={e => setTemplate(e.target.value)}
                spellCheck={false}
              />

              <div className="flex justify-between items-center" style={{ marginTop: 12 }}>
                <span className="mono text-muted" style={{ fontSize: 11 }}>
                  {template.split('\n').length} строк · {template.length} символов
                </span>
                <div className="flex gap-8">
                  <button className="btn btn-ghost btn-sm" onClick={resetTemplate}>↺ Сбросить</button>
                  <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={regenerating}>
                    {regenerating ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '⟳ Обновить все подписки'}
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={saveTemplate} disabled={saving || !isTemplateChanged}>
                    {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : '💾 Сохранить шаблон'}
                  </button>
                </div>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title">Как работает</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.7 }}>
                При создании Xray клиента панель автоматически генерирует подписку — YAML файл с этим шаблоном и VLESS нодой.
                Подписка доступна по уникальному URL вида <code className="mono" style={{ fontSize: 11 }}>/sub/client-abc123</code>.
                <br /><br />
                При нажатии "Обновить все подписки" — все существующие YAML пересчитываются из текущего шаблона.
                Это полезно когда меняешь правила роутинга (добавил домены в DIRECT, изменил proxy-groups и т.д.).
              </div>
            </div>
          </div>
        )}

        {/* ── Настройки ───────────────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div style={{ maxWidth: 480 }}>
            <div className="card">
              <div className="card-title">Настройки подписок</div>

              <div className="input-group">
                <label className="input-label">IP / Hostname VPS</label>
                <input
                  className="input input-mono"
                  placeholder="77.91.79.177"
                  value={vpsHost}
                  onChange={e => setVpsHost(e.target.value)}
                />
                <div className="text-muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                  Используется в VLESS URI подписок. Если пусто — берётся из настроек сервера.
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={saveSettings}>💾 Сохранить</button>
              </div>
            </div>

            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title">Формат URL подписки</div>
              <div className="config-box" style={{ fontSize: 12 }}>
                {`http://<VPS_IP>:8080/sub/<slug>\n\nПример:\nhttp://77.91.79.177:8080/sub/ruslan-abc123\n\nВсё идёт через nginx на том же порту что и панель.`}
              </div>
              <div className="text-muted mono" style={{ fontSize: 11, marginTop: 8 }}>
                Вставляй URL в FLClash → Profiles → Add → Remote
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
