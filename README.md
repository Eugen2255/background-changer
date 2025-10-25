# Background Changer — Human Segmentation App

Живой сменщик фона для веб-камеры на базе **MediaPipe Selfie Segmentation + Pose** (руки/кисти дорисовываются по позе), с локальной авторизацией, галереей фонов и «бейджем сотрудника» с уровнями приватности (`low` / `medium` / `high`).

## Возможности

- Сегментация человека в реальном времени (WebRTC + MediaPipe).
- Режимы фона: **цвет**, **размытие**, **изображение** (с загрузкой своих бэкграундов).
- Аккуратные руки/кисти на основе **Pose** (локти→запястья + эллипсы ладоней) — меньше «откушенных» пальцев.
- «Halo removal» на краю маски, мягкое «перо» внутрь — меньше ореола вокруг головы.
- HUD производительности (FPS / загрузка CPU / heap / GPU); клавиша **G** — показать/скрыть.
- Локальная регистрация/логин, хранение пользователей в `users.json`, папки пользователей с фонами.
- Оверлей с данными сотрудника из JSON с уровнями приватности (**low**, **medium**, **high**).

---

## Как запустить локально

### 1) Клонирование и окружение

```bash
git clone https://github.com/Eugen2255/background-changer.git
cd background-changer

# Рекомендуем Python 3.10+ (Windows/macOS/Linux)
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS / Linux:
source venv/bin/activate

pip install -r requirements.txt
```

### 2) Запуск бэкенда (FastAPI)

```bash
uvicorn backend.main:app --reload --port 8080
```

Бэкенд поднимется на `http://127.0.0.1:8080`.

> По умолчанию:
>
> - Пользователи хранятся в `backend/users.json`.
> - Базовые фоны — в `backend/static/` (положите туда изображения).
> - Папки пользователей — в `backend/users/` (создаются автоматически).
> - Фронтенд как статика:  
>   `/auth` → `frontend/auth`, `/segmentation` → `frontend/segmentation`, `/privacy` → `privacy`, `/` → `frontend/auth`.

### 3) Открыть фронтенд

Откройте в браузере:

- **Страница входа/регистрации:** `http://127.0.0.1:8080/auth/`  
- **Страница сегментации:** `http://127.0.0.1:8080/segmentation/`

> Если фронтенд ссылается на другой порт, замените `API_BASE` в JS-файлах фронтенда на `http://127.0.0.1:8080`.

---

## Использование

1. Перейдите на `/auth/`, зарегистрируйтесь и войдите.
2. Попадёте на `/segmentation/`:
   - Дайте браузеру доступ к камере.
   - Выберите фон: **Color**, **Blur** или **Image** (можно загрузить свои).
   - Включите/выключите данные сотрудника и переключайте уровни **low / medium / high** (кнопки на панели).
   - Нажмите `G`, чтобы показать/спрятать HUD (FPS, CPU, heap, GPU).

---

## API (кратко)

- `POST /register/` — регистрация (JSON: `username`, `password`, `email`).  
- `POST /login` — вход, возвращает JWT и `user_id`.  
- `GET /backgrounds/{user_id}` — список фонов пользователя.  
- `POST /upload_background/` — загрузка фона (`multipart/form-data`: `user_id`, `file`).  
- `GET /users/{user_id}/{filename}` — выдача файла фона.  
- Статика: `/auth`, `/segmentation`, `/privacy`, `/static`, `/users`.

---

## Приватность данных сотрудника

В папке [`privacy/`](./privacy/) лежат **разрезанные файлы** для уровней приватности:

- `low_privacy.json`
- `medium_privacy.json`
- `high_privacy.json`

Фронтенд подгружает соответствующий JSON и выводит оверлей. Вы можете изменять содержимое этих файлов под свои требования (например, показывать e‑mail только в `medium/high`).

---

## Структура проекта

```
background-changer/
├─ backend/
│  ├─ main.py               # FastAPI: auth, загрузка/выдача фонов, статика
│  ├─ users.json            # (создаётся) база пользователей
│  ├─ static/               # базовые фоны (положите картинки сюда)
│  └─ users/                # папки пользователей с их фонами
├─ frontend/
│  ├─ auth/                 # страница логина/регистрации (HTML/CSS/JS)
│  └─ segmentation/         # страница сегментации (HTML/CSS/JS)
├─ privacy/
│  ├─ low_privacy.json
│  ├─ medium_privacy.json
│  └─ high_privacy.json
├─ requirements.txt
└─ README.md
```

---

## Зависимости

Бэкенд: **FastAPI**, **Uvicorn**, **python-jose**, **passlib** (хэширование паролей), **python-multipart** (загрузка файлов) и др. Смотрите точный список в `requirements.txt`.

Фронтенд: нативный HTML/CSS/JS; **MediaPipe Selfie Segmentation** и **MediaPipe Pose** подключаются с CDN.

---

## Безопасность и примечания

- Проект демонстрационный. **Не используйте в продакшене** без доработок.
- Замените `SECRET_KEY` в `backend/main.py`.
- Пароли хэшируются через `passlib`. На Windows бывают проблемы с `bcrypt`; при необходимости используйте `pbkdf2_sha256`/`argon2` в `CryptContext`.
- Хранилище — файл `users.json`. Эндпоинты раздачи фоновых файлов не защищены.
- Разрешите доступ к камере в браузере; для стабильности запускайте через `http://127.0.0.1`.
