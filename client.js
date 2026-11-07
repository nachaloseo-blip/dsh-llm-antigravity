window.__ModuleLoader__.load({
  id: '@local/dsh-llm-antigravity',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const CSS = `
.ag-page { display: flex; flex-direction: column; gap: 16px; padding: 24px 24px 40px; max-width: 780px; }
.ag-title { margin: 0; font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ag-subtitle { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.ag-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.ag-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ag-card-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ag-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ag-muted { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ag-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.ag-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.ag-dot.ok { background: var(--dsw-alias-state-success-primary); }
.ag-dot.warn { background: var(--dsw-alias-state-warn-primary); }
.ag-dot.error { background: var(--dsw-alias-state-error-primary); }
.ag-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
.ag-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.ag-btn.primary { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.ag-btn:disabled { opacity: .5; cursor: default; }
.ag-input { flex: 1 1 260px; min-width: 200px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.ag-warn { border: 1px solid var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); display: flex; flex-direction: column; gap: 8px; }
.ag-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; white-space: pre-wrap; }
.ag-ok { color: var(--dsw-alias-state-success-primary); font-size: 12px; }
.ag-list { display: flex; flex-direction: column; gap: 10px; }
.ag-item { display: flex; align-items: flex-start; gap: 10px; }
.ag-item-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.ag-item-title { font-size: 13px; color: var(--dsw-alias-label-primary); }
.ag-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ag-spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: ag-spin 1s linear infinite; flex: none; }
@keyframes ag-spin { to { transform: rotate(360deg); } }
`;

    async function api(path, options) {
      const headers = { 'x-antigravity-ui': '1' };
      if (options && options.body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`/antigravity/${path}`, {
        ...options,
        headers: { ...headers, ...(options && options.headers) },
      });
      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    }

    function statusLabel(t, status, signedInLabel) {
      if (!status) return t('loading');
      if (!status.signedIn) return t('notSignedIn');
      return signedInLabel(status.email || 'unknown');
    }

    function formatDate(value) {
      if (!value) return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '';
      }
    }

    function AntigravitySettings(props) {
      const t = props.translate;
      const signedInLabel = email => {
        const template = t('signedInAs');
        return template.includes('{email}') ? template.replace('{email}', email) : `${template}: ${email}`;
      };
      const [status, setStatus] = useState(null);
      const [doctor, setDoctor] = useState(null);
      const [attempt, setAttempt] = useState(null);
      const [accepted, setAccepted] = useState(false);
      const [code, setCode] = useState('');
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');

      const refresh = useCallback(async () => {
        try {
          const next = await api('status');
          setStatus(next);
          if (next.attempt) setAttempt(next.attempt);
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      const loadDoctor = useCallback(async () => {
        try {
          setDoctor(await api('doctor'));
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      useEffect(() => {
        refresh();
        loadDoctor();
      }, [refresh, loadDoctor]);

      // Poll one pending browser attempt until it settles.
      useEffect(() => {
        if (!attempt || attempt.state !== 'pending') return undefined;
        const id = setInterval(async () => {
          try {
            const next = await api(`attempt?id=${encodeURIComponent(attempt.id)}`);
            if (next.state !== 'pending') {
              setAttempt(next);
              if (next.state === 'authorized') {
                setNotice(t('signInDone'));
                await refresh();
                await loadDoctor();
              } else if (next.error) {
                setError(next.error);
              }
            }
          } catch {
            // Keep polling; a transient read failure is not a login failure.
          }
        }, 1500);
        return () => clearInterval(id);
      }, [attempt, refresh, loadDoctor, t]);

      const startLogin = async () => {
        setError('');
        setNotice('');
        setBusy('login');
        // Open the tab inside the click gesture so the popup is not blocked;
        // navigate it to the exact URL the Host returns (never through a shell).
        let tab = null;
        try {
          tab = window.open('about:blank', '_blank');
        } catch {
          tab = null;
        }
        try {
          const next = await api('login', { method: 'POST', body: JSON.stringify({}) });
          setAttempt(next);
          if (next.url) {
            if (tab && !tab.closed) tab.location.href = next.url;
            else window.open(next.url, '_blank', 'noopener');
          } else if (tab) {
            tab.close();
          }
        } catch (err) {
          if (tab && !tab.closed) tab.close();
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const submitCode = async () => {
        if (!attempt || !code.trim()) return;
        setBusy('code');
        setError('');
        try {
          const next = await api('login/code', {
            method: 'POST',
            body: JSON.stringify({ attemptId: attempt.id, value: code.trim() }),
          });
          setAttempt(next);
          if (next.state === 'authorized') {
            setNotice(t('signInDone'));
            setCode('');
            await refresh();
            await loadDoctor();
          } else if (next.error) {
            setError(next.error);
          }
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const cancel = async () => {
        setBusy('cancel');
        try {
          const next = await api('cancel', { method: 'POST', body: JSON.stringify({}) });
          setAttempt(next);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const logout = async () => {
        setBusy('logout');
        try {
          await api('logout', { method: 'POST', body: JSON.stringify({}) });
          setAttempt(null);
          setNotice(t('signedOut'));
          await refresh();
          await loadDoctor();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const fix = async id => {
        setBusy(id);
        setError('');
        try {
          const result = await api('doctor/fix', {
            method: 'POST',
            body: JSON.stringify({ id }),
          });
          if (result.doctor) setDoctor(result.doctor);
          if (result.message) setError(result.message);
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy('');
        }
      };

      const actionLabel = action => {
        if (action === 'create-dir') return t('fixCreateDir');
        if (action === 'install') return t('fixInstall');
        return t('fixRetry');
      };

      const pending = attempt && attempt.state === 'pending';
      const submitted = attempt && (attempt.state === 'timeout' || attempt.state === 'failed');

      return h(
        'div',
        { className: 'ag-page' },
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'head' },
          h('h2', { className: 'ag-title' }, t('title')),
          h('p', { className: 'ag-subtitle' }, t('subtitle')),
        ),
        error ? h('div', { key: 'error', className: 'ag-error' }, error) : null,
        notice ? h('div', { key: 'notice', className: 'ag-ok' }, notice) : null,

        h('div', { className: 'ag-card', key: 'account' },
          h('div', { className: 'ag-card-head' },
            h('div', { className: 'ag-card-title' }, t('account')),
            h('div', { className: 'ag-row' },
              status && status.signedIn
                ? h('button', {
                    className: 'ag-btn',
                    key: 'refresh',
                    disabled: busy !== '' || !status.refreshable,
                    onClick: async () => {
                      setBusy('refresh');
                      try {
                        await api('refresh', { method: 'POST', body: JSON.stringify({}) });
                        setNotice(t('tokenRefreshed'));
                        await refresh();
                      } catch (err) {
                        setError(String(err.message || err));
                      } finally {
                        setBusy('');
                      }
                    },
                  }, t('refresh'))
                : null,
              status && status.signedIn
                ? h('button', {
                    className: 'ag-btn',
                    key: 'logout',
                    disabled: busy !== '',
                    onClick: logout,
                  }, t('signOut'))
                : h('button', {
                    className: 'ag-btn primary',
                    key: 'login',
                    disabled: busy !== '' || pending || !accepted,
                    onClick: startLogin,
                  }, pending ? t('waiting') : t('signIn')),
            ),
          ),
          h('div', { className: 'ag-row' },
            h('span', { className: 'ag-dot ' + (status && status.signedIn ? 'ok' : 'warn') }),
            h('span', { className: 'ag-muted' }, statusLabel(t, status, signedInLabel)),
          ),
          status && status.signedIn
            ? h('div', { className: 'ag-list' },
                h('div', { className: 'ag-row' },
                  h('span', { className: 'ag-muted' }, t('project')),
                  h('span', { className: 'ag-mono' }, status.projectId || '—'),
                ),
                h('div', { className: 'ag-row' },
                  h('span', { className: 'ag-muted' }, t('expires')),
                  h('span', { className: 'ag-mono' }, status.expiresAt ? formatDate(status.expiresAt) : '—'),
                ),
                h('div', { className: 'ag-row' },
                  h('span', { className: 'ag-muted' }, t('credentialsFile')),
                  h('span', { className: 'ag-mono' }, status.credentialsFile || '—'),
                ),
              )
            : null,
          pending
            ? h('div', { className: 'ag-list' },
                h('div', { className: 'ag-row' },
                  h('span', { className: 'ag-spinner' }),
                  h('span', { className: 'ag-muted' }, attempt.portBusy ? t('portBusy') : t('waiting')),
                ),
                h('div', { className: 'ag-row' },
                  h('a', { className: 'ag-mono', href: attempt.url, target: '_blank', rel: 'noreferrer' }, attempt.url),
                ),
                h('div', { className: 'ag-row' },
                  h('input', {
                    className: 'ag-input',
                    placeholder: t('pastePlaceholder'),
                    value: code,
                    onChange: event => setCode(event.target.value),
                  }),
                  h('button', { className: 'ag-btn', disabled: busy !== '', onClick: submitCode }, t('submitCode')),
                  h('button', { className: 'ag-btn', disabled: busy !== '', onClick: cancel }, t('cancel')),
                ),
              )
            : null,
          submitted
            ? h('div', { className: 'ag-list' },
                h('div', { className: 'ag-muted' }, attempt.error || t('timeoutHint')),
                h('div', { className: 'ag-row' },
                  h('input', {
                    className: 'ag-input',
                    placeholder: t('pastePlaceholder'),
                    value: code,
                    onChange: event => setCode(event.target.value),
                  }),
                  h('button', { className: 'ag-btn', disabled: busy !== '', onClick: submitCode }, t('submitCode')),
                  h('button', { className: 'ag-btn', disabled: busy !== '', onClick: startLogin }, t('restart')),
                ),
              )
            : null,
          !status || !status.signedIn || pending
            ? h('div', { className: 'ag-warn' },
                h('label', { className: 'ag-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: accepted,
                    onChange: event => setAccepted(event.target.checked),
                  }),
                  h('span', {}, t('tosWarning')),
                ),
              )
            : null,
        ),

        h('div', { className: 'ag-card', key: 'doctor' },
          h('div', { className: 'ag-card-head' },
            h('div', { className: 'ag-card-title' }, t('doctor')),
            h('button', {
              className: 'ag-btn',
              disabled: busy !== '',
              onClick: async () => {
                setBusy('doctor');
                await loadDoctor();
                setBusy('');
              },
            }, t('recheckAll')),
          ),
          doctor && doctor.items
            ? h('div', { className: 'ag-list' },
                doctor.items.map(item => h('div', { className: 'ag-item', key: item.id },
                  h('span', { className: 'ag-dot ' + item.status, style: { marginTop: 6 } }),
                  h('div', { className: 'ag-item-body' },
                    h('span', { className: 'ag-item-title' }, item.title),
                    h('span', { className: 'ag-muted' }, item.detail),
                  ),
                  item.action === 'signin'
                    ? h('button', {
                        className: 'ag-btn',
                        disabled: busy !== '' || !accepted || pending,
                        onClick: startLogin,
                      }, t('signIn'))
                    : item.action
                      ? h('button', {
                          className: 'ag-btn',
                          disabled: busy !== '',
                          onClick: () => fix(item.id),
                        }, actionLabel(item.action))
                      : null,
                )),
              )
            : h('div', { className: 'ag-muted' }, t('loading')),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dictionaries = {
          en: {
            title: 'Google Antigravity',
            subtitle: 'Gemini and Claude models supplied by an Antigravity subscription.',
            account: 'Account',
            signIn: 'Sign in with Google',
            signOut: 'Sign out',
            waiting: 'Waiting for the browser sign-in…',
            refresh: 'Refresh token',
            project: 'Project',
            expires: 'Token expires',
            credentialsFile: 'Credentials file',
            signedInAs: 'Signed in as {email}',
            notSignedIn: 'Not signed in — models are unavailable',
            loading: 'Loading…',
            doctor: 'Environment check',
            recheckAll: 'Re-check',
            fixRetry: 'Retry',
            fixCreateDir: 'Create folder',
            fixInstall: 'Install',
            pastePlaceholder: 'Paste the redirect URL or the code',
            submitCode: 'Confirm',
            cancel: 'Cancel',
            restart: 'Start over',
            timeoutHint: 'The automatic callback did not arrive. Paste the browser redirect URL.',
            portBusy: 'The local port 51121 is busy — copy the browser address-bar URL and paste it here.',
            tosWarning:
              'Google forbids third-party access to Antigravity through Antigravity OAuth and has disabled accounts for it. I understand the risk and want to continue.',
            signInDone: 'Signed in. Antigravity models are now available in the model picker.',
            signedOut: 'Signed out.',
            tokenRefreshed: 'Access token refreshed.',
            unknownError: 'Request failed.',
          },
          ru: {
            title: 'Google Antigravity',
            subtitle: 'Модели Gemini и Claude из подписки Antigravity.',
            account: 'Аккаунт',
            signIn: 'Войти через Google',
            signOut: 'Выйти',
            waiting: 'Ожидание входа в браузере…',
            refresh: 'Обновить токен',
            project: 'Проект',
            expires: 'Токен действует до',
            credentialsFile: 'Файл токенов',
            signedInAs: 'Вход выполнен: {email}',
            notSignedIn: 'Вход не выполнен — модели недоступны',
            loading: 'Загрузка…',
            doctor: 'Проверка окружения',
            recheckAll: 'Проверить снова',
            fixRetry: 'Повторить',
            fixCreateDir: 'Создать папку',
            fixInstall: 'Установить',
            pastePlaceholder: 'Вставьте ссылку из браузера или код',
            submitCode: 'Подтвердить',
            cancel: 'Отмена',
            restart: 'Начать заново',
            timeoutHint: 'Автоматический ответ не пришёл. Вставьте ссылку из адресной строки браузера.',
            portBusy: 'Порт 51121 занят — скопируйте ссылку из адресной строки браузера и вставьте её сюда.',
            tosWarning:
              'Google запрещает сторонний доступ к Antigravity через Antigravity OAuth и уже отключал за это аккаунты. Я понимаю риск и хочу продолжить.',
            signInDone: 'Вход выполнен. Модели Antigravity доступны в выборе модели.',
            signedOut: 'Вы вышли из аккаунта.',
            tokenRefreshed: 'Токен обновлён.',
            unknownError: 'Запрос не выполнен.',
          },
        };

        for (const [locale, dict] of Object.entries(dictionaries)) {
          ctx.effect(() => ctx.locale.register('antigravity', locale, dict), `antigravity: ${locale}`);
        }
        // Built-in locales other than the two translated ones fall back to the
        // English dictionary instead of showing raw keys.
        for (const locale of ['zh', 'ja', 'es', 'fr', 'de', 'pt']) {
          ctx.effect(
            () => ctx.locale.register('antigravity', locale, dictionaries.en),
            `antigravity: ${locale} fallback`,
          );
        }
        const translate = ctx.locale.bind('antigravity');

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'antigravity',
              order: 30,
              label: () => translate('title'),
            },
            function AntigravitySection() {
              const [, force] = React.useState(0);
              React.useEffect(() => ctx.locale.subscribe(() => force(value => value + 1)), []);
              return h(AntigravitySettings, { translate });
            },
          ),
        );
      },
    };
  },
});
