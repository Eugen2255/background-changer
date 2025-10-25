// === AUTH.JS ===
// Управляет авторизацией (вход / регистрация) и переходом на страницу сегментации

// ⚠️ Проверь порт uvicorn: --port 8080 (или поменяй тут)
const API_BASE = "http://127.0.0.1:8080";

// Пути API (если переименуешь на /api/..., обнови тут)
const REGISTER_URL = `${API_BASE}/register/`;
const LOGIN_URL    = `${API_BASE}/login`;

// Универсальный парсер ответа: сначала читаем текст, затем пытаемся JSON
async function parseResponse(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    try { return { data: JSON.parse(text), raw: text }; }
    catch { /* вернём как текст ниже */ }
  }
  return { data: text, raw: text };
}

const auth = {
  currentUser: null,

  checkAuth() {
    const token = localStorage.getItem("access_token");
    const user = JSON.parse(localStorage.getItem("user") || "null");
    if (token && user) {
      this.currentUser = user;
      console.log("🔓 Пользователь найден:", user.username);
    } else {
      console.log("🔒 Пользователь не авторизован");
    }
  },

  async register() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value.trim();
    const email    = document.getElementById("email").value.trim();

    if (!username || !password || !email) {
      this._showMessage("❗ Заполните все поля перед регистрацией.", "error");
      return;
    }

    try {
      const res = await fetch(REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, email }),
      });

      const { data } = await parseResponse(res);

      if (res.ok) {
        this._showMessage("✅ Регистрация успешна! Теперь войдите.", "success");
      } else {
        const msg = typeof data === "string" ? data : (data.detail || JSON.stringify(data));
        this._showMessage(`Ошибка регистрации: ${msg}`, "error");
      }
    } catch (e) {
      this._showMessage("Ошибка сети: " + e.message, "error");
    }
  },

  async login() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value.trim();

    if (!username || !password) {
      this._showMessage("Введите логин и пароль.", "error");
      return;
    }

    try {
      const res = await fetch(LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const { data } = await parseResponse(res);

      if (res.ok && data && typeof data === "object") {
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("user", JSON.stringify({ user_id: data.user_id, username }));
        this.currentUser = { user_id: data.user_id, username };

        this._showMessage(`👋 Добро пожаловать, ${username}!`, "success");
        setTimeout(() => { window.location.href = "/segmentation/"; }, 900);
      } else {
        const msg = typeof data === "string" ? data : (data.detail || JSON.stringify(data));
        this._showMessage("Ошибка входа: " + msg, "error");
      }
    } catch (e) {
      this._showMessage("Ошибка сети: " + e.message, "error");
    }
  },

  logout() {
    localStorage.removeItem("access_token");
    localStorage.removeItem("user");
    this.currentUser = null;
    this._showMessage("👋 Вы вышли из системы.", "info");
    setTimeout(() => { window.location.href = "/auth/"; }, 700);
  },

  _showMessage(text, type = "info") {
    const box = document.createElement("div");
    box.className = `auth-toast ${type}`;
    box.textContent = text;
    document.body.appendChild(box);
    setTimeout(() => box.classList.add("visible"), 20);
    setTimeout(() => {
      box.classList.remove("visible");
      setTimeout(() => box.remove(), 300);
    }, 2800);
  },
};

window.onload = () => auth.checkAuth();
