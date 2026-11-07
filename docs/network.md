# Сеть: какие домены должны идти через VPN

Плагин обращается к шести доменам Google. Из России без VPN часть из них недоступна, а Gemini дополнительно проверяет регион по IP и отвечает `400 User location is not supported`.

## Домены

| Домен | Кто обращается | Зачем | Нужен VPN из РФ |
|---|---|---|---|
| `daily-cloudcode-pa.googleapis.com` | плагин (Node) | основной релей Cloud Code Assist: список моделей и генерация | да |
| `cloudcode-pa.googleapis.com` | плагин (Node) | резервный релей | да |
| `daily-cloudcode-pa.sandbox.googleapis.com` | плагин (Node) | резервный релей; часто единственный доступный из РФ | да для Gemini |
| `accounts.google.com` | браузер | страница входа Google | для входа |
| `oauth2.googleapis.com` | плагин (Node) | обмен кода на токены и refresh | для входа и обновления токена |
| `www.googleapis.com` | плагин (Node) | `userinfo` — email аккаунта | только при входе |

Домены `*.googleapis.com` из списка — это именно те, что нужны Harness. Приложению Antigravity IDE может требоваться больше хостов; здесь перечислено только то, что использует плагин.

## Поведение без VPN (наблюдение)

С машины в РФ без маршрута через поддерживаемый регион:

- `daily-cloudcode-pa.googleapis.com` — `ECONNRESET` на TLS-хендшейке;
- `cloudcode-pa.googleapis.com` — `ECONNRESET`;
- `daily-cloudcode-pa.sandbox.googleapis.com` — отвечает `200` на список моделей, но генерация Gemini возвращает `400 User location is not supported`;
- Claude через sandbox-хост работает и без VPN (проверено на живом аккаунте).

С маршрутом через поддерживаемый регион (например, Финляндия) работают все модели.

## Если установлен Antigravity Unlocker

Анлокер (например, [confeden/Antigravity](https://github.com/confeden/Antigravity)) добавляет правила **NRPT** для `cloudcode-pa.googleapis.com` и `daily-cloudcode-pa.googleapis.com` и уводит эти имена на loopback (`127.65.71.x`), где слушает его локальный релей. Node в Harness использует системный DNS, поэтому тоже попадёт на loopback-адрес и получит `ECONNRESET`, даже если VPN настроен на эти домены.

Проверить:

```powershell
Resolve-DnsName daily-cloudcode-pa.googleapis.com -Type A
# 127.65.71.2 -> DNS перехвачен анлокером
Get-DnsClientNrptRule | Select-Object Namespace, NameServers
```

Варианты:

- временно отключить DNS-правила анлокера (`Disable-DnsClientNrptRule`) на время работы плагина;
- использовать VPN, который сам отвечает за DNS этих доменов и перекрывает NRPT;
- не полагаться на анлокер: плагину нужен обычный сетевой маршрут, а не его локальный релей.

Локальный релей анлокера (`http://127.0.0.1:53129`) принимает CONNECT, но при запросах из сторонних процессов в наших замерах отвечал `ECONNRESET`; как штатный транспорт для плагина он не используется.

## Быстрая проверка маршрута

```powershell
# 1. Куда резолвится домен (не должно быть 127.x)
Resolve-DnsName daily-cloudcode-pa.googleapis.com -Type A

# 2. Открывается ли TLS и отвечает ли релей
curl.exe -sS -o NUL -w "%{http_code}`n" https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels -X POST -H "Content-Type: application/json" -d "{}"

# 3. Проверка из самого плагина
#    Настройки -> Antigravity -> Проверка окружения -> «Проверить снова»
```

Ожидаемый код на шаге 2 без токена — `401` или `403` (значит, соединение и TLS есть); `000`/таймаут/`ECONNRESET` означают, что маршрута нет.

## Регион и модели

Региональная проверка применяется к Gemini. Claude через тот же релей отдаётся без неё. Если Gemini отвечает `400 User location is not supported`, а Claude работает — маршрут VPN не покрывает нужный регион или перехвачен DNS, а не «сломался плагин».
