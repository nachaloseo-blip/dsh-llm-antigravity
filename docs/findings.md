# Наблюдения

Заметки по протоколу Antigravity / Cloud Code Assist, собранные при разработке плагина. Часть выводов получена сравнением с MIT-проектами [hermes-antigravity](https://github.com/zeyxx/hermes-antigravity) и [pi-antigravity](https://github.com/Rahularya01/pi-antigravity), часть — живыми запросами.

## 1. OAuth

- Google не выдаёт API-ключи для потребительских подписок (AI Pro, AI Ultra, студенческие). Единственный путь — OAuth того же публичного desktop-клиента, что использует Antigravity.
- Поток: authorization code + PKCE (S256), `state`, `access_type=offline`, `prompt=select_account`.
- Redirect зарегистрирован ровно как `http://localhost:51121/oauth-callback`; порт менять нельзя.
- Скоупы: `aicode`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`.
- Client secret в desktop-клиенте не является секретом: он поставляется в бинарнике и не даёт доступа без интерактивного входа. Чувствительны только выданные токены.
- Проект подписки определяется через `POST /v1internal:loadCodeAssist` (поле `cloudaicompanionProject`). На проверенном аккаунте вернулся `aicode-consumers`.

## 2. Запрос

`POST {endpoint}/v1internal:streamGenerateContent?alt=sse`

Внешний конверт:

```json
{
  "project": "<projectId>",
  "model": "<runtime model id>",
  "request": { "...": "внутренний Gemini-запрос" },
  "requestType": "agent",
  "userAgent": "antigravity",
  "requestId": "<trajectoryId>-<requestIndex>-<step>"
}
```

Внутри `request`:

- `contents[]` со строгим чередованием `user`/`model`, начиная с `user`;
- `systemInstruction` (роль `user`);
- `generationConfig`: `temperature`, `maxOutputTokens`, `thinkingConfig.thinkingBudget`;
- `tools[0].functionDeclarations[]` — схемы очищаются от `anyOf/oneOf/allOf/not/$defs/...`, Claude их не принимает;
- `sessionId` и `labels` — **внутри** `request`, иначе `400 INVALID_ARGUMENT` как неизвестные поля;
- `labels`: `antigravity/cli-version`, `antigravity/model`, `antigravity/step`, `antigravity/last-step-index`, для Claude ещё `antigravity/provider=anthropic`.

`User-Agent` должен быть вида `antigravity/cli/<version> (...)` — релей различает клиентов по нему.

## 3. Роутинг моделей

Квота считается по **рантайм-id** с суффиксом, а не по публичному. Отправка `gemini-3.8-flash` может вернуть `429` при живой квоте, тогда как `gemini-3.8-flash-low` отвечает.

| Публичный id | off | low | medium | high |
|---|---|---|---|---|
| `gemini-3.8-flash` | `-low` | `-low` | `-medium` | `-high` |
| `gemini-3.7-flash` | `-low` | `-low` | `-medium` | `-high` |
| `gemini-3.1-pro` | `-low` | `-low` | `-low` | `gemini-pro-agent` |
| `claude-sonnet-4-6` | сам id | | | |
| `claude-opus-4-6` | `-thinking` | | | |

`model_enum` (например `MODEL_PLACEHOLDER_M320`) не выводится из id: его сообщает только `fetchAvailableModels`, иначе поле лучше не отправлять.

## 4. Ответ

SSE-строки `data: {"response": {...}}`:

- `candidates[0].content.parts[]`: `{text}` / `{text, thought:true}` (reasoning) / `{functionCall:{name,args,id}, thoughtSignature}`;
- `candidates[0].finishReason`: `STOP`, `MAX_TOKENS`;
- `usageMetadata`: `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`, `thoughtsTokenCount`, `cachedContentTokenCount`.

`thoughtSignature` нужно вернуть в следующем запросе вместе с tool-call, иначе Gemini 3 отклоняет шаг. Без подписи безопаснее превратить вызов в текстовый ход `[Action: ...]`, чем подделывать сигнатуру.

## 5. Каталог и квоты

- `POST /v1internal:fetchAvailableModels` с `{project}` возвращает карту моделей аккаунта: рантайм-id, `displayName`, `tagTitle`, `quotaInfo.remainingFraction/resetTime`.
- `tagTitle` со словами `Leaving Soon` / `Unavailable` означает, что модель рекламировать нельзя.
- Статический список не должен подменять живой: релей знает лучше.
- `loadCodeAssist` отдаёт `currentTier` / `paidTier` — план подписки.

## 6. Региональный гейт

- `400 FAILED_PRECONDITION: "User location is not supported for the API use."` — проверка по IP, применяется к Gemini.
- Проверка **зависит от хоста/ребра**: в замерах один и тот же запрос то получал `400`, то проходил.
- Claude через тот же релей отдаётся без проверки региона.
- Отсюда в адаптере: перебор всех хостов релея, `REGION_BLOCKED` помечен как retryable, ошибка показывается человеческим текстом.

## 7. Транспорт и DNS

- Из РФ `daily-cloudcode-pa` и `cloudcode-pa` часто отвечают `ECONNRESET` на TLS-хендшейке, а `daily-cloudcode-pa.sandbox` доступен.
- Antigravity Unlocker добавляет NRPT-правила для двух gate-хостов и уводит их на `127.65.71.x`. `Resolve-DnsName` показывает loopback, `dns.resolve4` (c-ares) — реальные адреса `172.217.x.x`.
- Node в Harness использует системный DNS, поэтому попадает на loopback анлокера и получает сброс. Для плагина нужен нормальный маршрут (VPN), а не локальный релей анлокера.
- Патч анлокера `ineligible → inexigible` — это исправление клиентской обработки ошибки авторизации в IDE, а не обход серверной проверки региона; саму генерацию у него вытягивает приватный relay.

## 8. Что проверено на живом аккаунте

| Проверка | Результат |
|---|---|
| OAuth PKCE + запись токена | работает |
| `fetchAvailableModels` | 200, 20 моделей аккаунта |
| Claude Sonnet 4.6 | `OK`, usage 12/4/16 |
| Gemini 3.8 Flash (через VPN-маршрут) | `OK`, usage с reasoning-токенами |
| Gemini 2.5 Flash | `OK` |
| Без маршрута | Gemini `400 User location is not supported`, Claude работает |

## 9. Открытые вопросы

- Сигнатуры для текстовых частей (не только tool-call) не воспроизводятся.
- Изображения не поддерживаются: маршрут объявлен текстовым.
- Точное поведение квоты между рантайм-вариантами (`-low/-medium/-high`) не измерялось систематически.
- Вёрстка страницы настроек проверялась ограниченно (без браузерного контроля).
