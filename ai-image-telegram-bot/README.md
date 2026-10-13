# Закрытый Telegram Image Bot

Node.js 20+, Telegraf, OpenAI Images API. Два режима: генерация и редактирование по референсу. Настройки: модель, размер, качество. Белый список Telegram ID, дневной лимит, один запрос на пользователя.

## Установка Ubuntu/Debian

```bash
node -v # версия >=20
sudo useradd --system --create-home --shell /usr/sbin/nologin aiimagebot
sudo mkdir -p /opt/ai-image-bot
sudo cp -r src package.json .env.example /opt/ai-image-bot/
sudo cp /opt/ai-image-bot/.env.example /opt/ai-image-bot/.env
sudo chown -R aiimagebot:aiimagebot /opt/ai-image-bot
cd /opt/ai-image-bot
sudo -u aiimagebot npm install --omit=dev
sudo nano /opt/ai-image-bot/.env
sudo chmod 600 /opt/ai-image-bot/.env
sudo cp /path/to/project/deploy/ai-image-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-image-bot
sudo journalctl -u ai-image-bot -f
```

Для команды копирования unit-файла замените `/path/to/project` на путь к распакованному архиву. Node.js 20+ нужно установить отдельно, если он отсутствует. Убедитесь, что `which node` показывает `/usr/bin/node`; иначе измените `ExecStart`.

## Настройки

Создайте `.env` по `.env.example`. Укажите токен от @BotFather, OpenAI API key, числовые Telegram ID через запятую. Не отправляйте секреты в чат и не публикуйте `.env`.

## Команды

`/start` — меню, `/menu` — меню, `/cancel` — отмена текущего сценария (не отменяет уже отправленный платный запрос).

## Ограничения

- История выбора настроек и дневной счётчик находятся в RAM: сбрасываются при перезапуске.
- При обработке фото Telegram file_id хранится в памяти только до завершения сценария; референс загружается непосредственно перед запросом и не записывается на диск.
- Для Images API поддерживаются `low`, `medium`, `high`; `max` не добавлен, так как это не подтверждённое значение API.
- Если модель или сочетание параметров недоступны для API-ключа, OpenAI вернёт ошибку. Перед платным вызовом нет гарантированного способа подтвердить все сочетания.
- Лимит считает успешные генерации, не фактические затраты при сбоях доставки Telegram.
- Для production с несколькими процессами и устойчивыми лимитами понадобится SQLite/Redis.
