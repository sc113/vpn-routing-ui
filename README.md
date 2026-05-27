# VPN Routing UI

[![Keenetic + Entware](https://img.shields.io/badge/Keenetic%20%2B%20Entware-router-22a699)](#требования)
[![Shell CGI](https://img.shields.io/badge/backend-POSIX%20sh%20CGI-555)](#структура-проекта)

Лёгкий web-интерфейс для роутеров `Keenetic + Entware`: VPN-профили, DNS-маршруты, состояние `ProxyN`, управление `xray`/`sing-box` и быстрые действия восстановления в одном месте.

Проект сознательно не пытается быть тяжёлой серверной панелью. Из проектов вроде `3x-ui` здесь полезны идеи вокруг установки, статуса, бэкапов, скриншотов и безопасных обновлений, но runtime остаётся маленьким: статические страницы, shell CGI и обычные файлы состояния.

## Скриншоты

![Обзор и управление ядрами](docs/screenshots/overview.png)

![Таблица DNS-маршрутов](docs/screenshots/dns-routes.png)

![Редактор DNS-групп](docs/screenshots/dns-groups.png)

## Возможности

- Три лёгкие страницы: обзор, профили/маршруты и DNS-группы.
- Левый sidebar между страницами в стиле лёгкой панели и быстрые вкладки-якоря внутри страницы профилей.
- Управление сервисами `xray` и `sing-box` прямо из UI.
- Установка, удаление и безопасное обновление VPN-движков через Entware `opkg`.
- Защита от prerelease-обновлений и рискованных upstream-сборок.
- Хранение профилей в обычных файлах без SQLite/PostgreSQL и отдельного backend-демона.
- Импорт популярных proxy-ссылок и генерация конфигов для роутерного runtime.
- Live-состояние `ProxyN`, понятные причины проблем и кнопки сброса/рестарта.
- DNS `domain-list` маршрутизация в `ProxyN` или напрямую через ISP.
- Полный маршрут выбранного LAN-устройства через конкретный `ProxyN`.
- Backup `running-config` перед изменением DNS-маршрутов и client policy.
- Экспорт/импорт DNS-групп в формате `vpn-routing-ui dns-groups v1`.
- GitHub raw-file sync для переноса DNS-групп между роутерами.
- Виджет CPU/RAM/процессов для быстрой диагностики роутера.

## Быстрая установка

Выполнить на роутере от `root`:

```sh
wget -qO- https://raw.githubusercontent.com/sc113/vpn-routing-ui/main/install.sh | sh
```

Потом открыть:

```text
http://192.168.1.1:92/
```

Та же команда обновляет уже установленный интерфейс.

Если на роутере ещё нет HTTPS/cert-пакетов для скачивания с GitHub:

```sh
opkg update
opkg install ca-bundle wget-ssl uhttpd
wget -qO- https://raw.githubusercontent.com/sc113/vpn-routing-ui/main/install.sh | sh
```

Вариант через `curl`:

```sh
curl -fsSL https://raw.githubusercontent.com/sc113/vpn-routing-ui/main/install.sh | sh
```

## Требования

- Keenetic OS с компонентами `SSH`, `Proxy`, `OPKG`.
- Entware в `/opt`.
- `uhttpd` в `/opt/sbin/uhttpd`.
- Для работы VPN-профилей:
  - `xray`
  - и/или `sing-box-go`

Installer попробует поставить отсутствующий `uhttpd` через `opkg`. VPN-движки можно поставить позже из самого интерфейса.

## Лёгкий По Дизайну

Проект рассчитан на домашний Keenetic без лишней нагрузки:

- статические HTML/CSS/JS страницы через `uhttpd`;
- POSIX `sh` CGI вместо Go/Node/Python-сервиса;
- без Docker, systemd, базы данных, миграций и тяжёлого dashboard;
- без фонового polling за пределами открытого UI;
- состояние лежит в `/opt/etc/vpn-routing-ui`.

Главное отличие от `3x-ui`: `3x-ui` - полноценная серверная Xray-панель, а `VPN Routing UI` - маленькая роутерная панель политик, DNS-маршрутизации и восстановления Keenetic.

## Что Делает Installer

- Создаёт:
  - `/opt/share/vpn-routing-ui`
  - `/opt/share/vpn-routing-ui/cgi-bin`
  - `/opt/share/vpn-routing-ui/bin`
  - `/opt/etc/vpn-routing-ui`
  - `/opt/etc/vpn-routing-ui-runtime`
- Устанавливает Entware init-скрипты:
  - `S66vpn-routing-tune`
  - `S67vpn-routing-engine-guard`
  - `S68vpn-routing-ui`
- Переносит старое состояние `neofit-ui`, если оно найдено.
- Запускает лёгкий web UI на порту `92`.

Важные файлы состояния:

```text
/opt/etc/vpn-routing-ui/profiles.json
/opt/etc/vpn-routing-ui/dns-routes.state
/opt/etc/vpn-routing-ui/router-proxies.map
/opt/etc/vpn-routing-ui/backups/
```

## Ручная Установка Из Архива

Если raw-скачивание с GitHub неудобно, можно передать подготовленный пакет на роутер и выполнить:

```sh
cd /opt/tmp/vpn-routing-ui-share
sh install.sh
```

Если на роутере есть `git`, можно поставить прямо из исходников:

```sh
git clone https://github.com/sc113/vpn-routing-ui.git
cd vpn-routing-ui
sh install.sh
```

## Перенос DNS-групп

Страница DNS-групп экспортирует текущие Keenetic `domain-list` группы в текстовый формат `vpn-routing-ui dns-groups v1`.

Этот же текст можно импортировать обратно через `router-dns-text-sync.cgi`. Импорт заменяет DNS-группы на роутере и перед применением сохраняет backup `running-config`.

## Безопасность

UI рассчитан на доверенную локальную сеть или доступ через SSH/VPN. Не публикуйте порт `92` в интернет.

Для удалённого доступа лучше использовать:

- VPN/WireGuard внутрь сети роутера;
- SSH tunnel до `192.168.1.1:92`;
- правила firewall в Keenetic, ограничивающие доступ к UI.

## Что Перенять У 3x-ui

Стоит держать или добавить в лёгком виде:

- установку/обновление одной командой из GitHub;
- понятный release-пакет с checksum;
- видимый статус версий движков и безопасных обновлений;
- ручной backup/export bundle для профилей, DNS-маршрутов и maps;
- on-demand обновление `geosite.dat`/`geoip.dat` только для движков, которым это нужно;
- компактную диагностику логов и сервисов;
- UI-настройку listen address/port.

Не стоит копировать на слабые роутеры:

- database backends;
- Docker deployment;
- Telegram bot и тяжёлые notification jobs;
- ACME/TLS management внутри панели;
- multi-user серверные функции, которые дублируют доступы Keenetic.

## Структура Проекта

- `shell/www/` - статический HTML/CSS/JS интерфейс.
- `shell/cgi/` - router API через маленькие CGI-скрипты.
- `shell/router/` - Entware init/helper-скрипты.
- `install.sh` - установка напрямую из GitHub или source checkout.
- `docs/screenshots/` - скриншоты для README.

## Удаление

```sh
/opt/etc/init.d/S68vpn-routing-ui stop
rm -f /opt/etc/init.d/S66vpn-routing-tune
rm -f /opt/etc/init.d/S67vpn-routing-engine-guard
rm -f /opt/etc/init.d/S68vpn-routing-ui
rm -rf /opt/share/vpn-routing-ui
```

Чтобы сохранить профили, состояние маршрутов и backup-файлы, не удаляйте:

```text
/opt/etc/vpn-routing-ui
```
