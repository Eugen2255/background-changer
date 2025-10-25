// === AUTH.JS ===
// Управляет авторизацией (вход / регистрация) и переходом на страницу сегментации

const API_BASE = "http://localhost:8000";

const auth = {
  currentUser: null,

  // при загрузке просто смотрим на наличие пользователя (без редиректов)
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
    const email = document.getElementById("email").value.trim();

    if (!username || !password || !email) {
      this._showMessage("❗ Заполните все поля перед регистрацией.", "error");
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/register/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, email }),
      });
      const data = await res.json();

      if (res.ok) {
        this._showMessage("✅ Регистрация успешна! Теперь войдите.", "success");
      } else {
        this._showMessage(`Ошибка: ${data.detail || JSON.stringify(data)}`, "error");
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
      const res = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("user", JSON.stringify({ user_id: data.user_id, username }));
        this.currentUser = { user_id: data.user_id, username };

        this._showMessage(`👋 Добро пожаловать, ${username}!`, "success");
        setTimeout(() => { window.location.href = "/segmentation/"; }, 900);
      } else {
        this._showMessage("Ошибка входа: " + (data.detail || JSON.stringify(data)), "error");
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
