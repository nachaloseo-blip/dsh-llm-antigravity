# dsh-llm-antigravity

Провайдер моделей **Google Antigravity** для DeepSeek Harness: Gemini и Claude из подписки Antigravity появляются в выборе модели рядом с DeepSeek — без платного API-ключа.

Плагин говорит с Google Cloud Code Assist напрямую (`v1internal:streamGenerateContent`), переводит сообщения, инструменты и стриминг в формат Harness и хранит OAuth-токен локально.

> **Важно.** Google запрещает использовать Antigravity через сторонний OAuth-клиент и блокировал за это аккаунты. Продолжая, вы принимаете риск для своего аккаунта Antigravity и Gemini CLI. ToS-совместимая альтернатива — обычный ключ Gemini AI Studio.

## Возможности

- Маршрут `antigravity` в `ctx.llm` — модели видны в композере Harness.
- Вход через Google OAuth 2.0 PKCE прямо в **Настройки → Antigravity**.
- Автообновление access-токена, выход, ручная вставка redirect-ссылки, если порт занят.
- Проверка окружения (Node, сервис моделей, папка токенов, порт 51121, доступ к Google, пакеты, подписка).
- Роутинг публичных id на квотные (`gemini-3.8-flash` + `high` → `gemini-3.8-flash-high`), лимиты вывода по семействам.
- Перебор всех хостов релея, повтор при региональном отказе, понятные коды ошибок.
- Стриминг текста, reasoning-токенов, tool-calls и usage; replay thought-сигнатур инструментов.

## Требования

- DeepSeek Harness с включённым плагином `@deepseek-ai/dsh-llm` (стандартный десктопный/веб-профиль).
- Node.js 20+ (используется встроенный `fetch`).
- Аккаунт Google с доступом к Antigravity.
- Сетевой маршрут: см. [docs/network.md](docs/network.md) — из России нужен VPN для релея и Gemini.

## Установка

Склонируйте репозиторий и установите каталог как bundle в профиль Harness:

```text
Plugin Manager → Install bundle → <абсолютный путь к клонированному каталогу>
```

(в агентском интерфейсе это `plugin_manager install_bundle` с абсолютным путём; пакет подключается как link, поэтому правки подхватываются из репозитория).

После установки:

1. **Настройки → Antigravity** → поставьте галочку согласия → **Войти через Google**.
2. В открывшейся вкладке войдите в аккаунт и подтвердите доступ.
3. Выберите модель в композере.

Запасной вход из терминала:

```powershell
node login.mjs --accept-risk
node login.mjs status
node login.mjs logout
```

Токены хранятся в `%USERPROFILE%\.dsh\antigravity\oauth.json` (переопределяется `ANTIGRAVITY_CREDENTIALS_FILE`).

## Сеть и VPN

Из России без VPN работают не все хосты, а Gemini дополнительно проверяет регион по IP. Полный список доменов и диагностика — в [docs/network.md](docs/network.md). Кратко, через VPN должны идти:

- `daily-cloudcode-pa.googleapis.com`
- `cloudcode-pa.googleapis.com`
- `daily-cloudcode-pa.sandbox.googleapis.com`
- `accounts.google.com`
- `oauth2.googleapis.com`
- `www.googleapis.com`

## Наблюдения

Технические заметки о протоколе, региональном гейте, DNS/NRPT и поведении релея — в [docs/findings.md](docs/findings.md). Там же зафиксировано, что проверено на живом аккаунте, а что осталось непроверенным.

## Ограничения

- Маршрут объявлен текстовым: изображения в истории доходят до модели плейсхолдерами.
- Сигнатуры tool-call воспроизводятся адаптером; неподписанный tool-call Gemini 3 понижается до текстового хода.
- Каталог моделей — публичный список плюс модели аккаунта; рантайм-id схлопываются в публичные.
- Встроенной поддержки прокси нет: маршрутизацию обеспечивает VPN/системный прокси окружения.
- Вход и ответы моделей проверены на живом аккаунте; вёрстка страницы проверялась ограниченно.

## Лицензия

MIT. Протокол и идеи частично основаны на MIT-проектах:

- [hermes-antigravity](https://github.com/zeyxx/hermes-antigravity) — Python-провайдер Antigravity для Hermes Agent;
- [pi-antigravity](https://github.com/Rahularya01/pi-antigravity) — пионер обратной разработки Cloud Code Assist для Pi.

---

## English

A Google Antigravity model provider for DeepSeek Harness. Registers an `antigravity`
route backed by the Cloud Code Assist streaming transport, authenticates with a
Google Antigravity subscription through OAuth 2.0 PKCE, and ships a Settings page
with sign-in, account status and an environment doctor.

Install the directory as a Harness bundle, open **Settings → Antigravity**, sign in,
then pick a model in the composer. See [docs/network.md](docs/network.md) for the
domains that must be routed through a supported-region VPN when running from Russia.

MIT licensed. Not affiliated with Google; using Antigravity third-party OAuth may
violate its terms and risk account suspension.
