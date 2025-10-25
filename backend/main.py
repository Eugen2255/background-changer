from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from passlib.context import CryptContext
from jose import jwt
from typing import List
import os, json, shutil

# === CONFIG ===
SECRET_KEY = "your-super-secret-key-change-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(CURRENT_DIR, "users.json")
STATIC_DIR = os.path.join(CURRENT_DIR, "static")  # базовые фоны
USERS_DIR = os.path.join(CURRENT_DIR, "users")    # папки пользователей

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(USERS_DIR, exist_ok=True)

# === PASSWORDS & TOKENS ===
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)

def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

# === MODELS ===
class UserRegistration(BaseModel):
    username: str
    password: str
    email: str

class UserLogin(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str
    user_id: str

class UserResponse(BaseModel):
    user_id: str
    username: str
    email: str

class BackgroundResponse(BaseModel):
    backgrounds: List[str]

# === STORAGE ===
def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            content = f.read().strip()
            return json.loads(content) if content else {}
    except json.JSONDecodeError:
        return {}

def save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, ensure_ascii=False, indent=2)

users_db = load_users()
BASE_BACKGROUND_NAMES = [
    f for f in os.listdir(STATIC_DIR) if os.path.isfile(os.path.join(STATIC_DIR, f))
]

# === APP ===
app = FastAPI(title="Human Segmentation App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # при желании ограничь
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# === AUTH ===
@app.post("/register/", response_model=UserResponse)
async def register(user_data: UserRegistration):
    for u in users_db.values():
        if u["username"] == user_data.username:
            raise HTTPException(status_code=400, detail="Username already exists")

    user_id = str(max([int(uid) for uid in users_db.keys()] or [0]) + 1)
    hashed = get_password_hash(user_data.password)

    user_dir = os.path.join(USERS_DIR, user_id)
    os.makedirs(user_dir, exist_ok=True)

    # Скопировать базовые фоны пользователю
    user_backgrounds = []
    for f in BASE_BACKGROUND_NAMES:
        src = os.path.join(STATIC_DIR, f)
        dst = os.path.join(user_dir, f)
        shutil.copy2(src, dst)
        user_backgrounds.append(f"/users/{user_id}/{f}")

    users_db[user_id] = {
        "user_id": user_id,
        "username": user_data.username,
        "email": user_data.email,
        "hashed_password": hashed,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "backgrounds": user_backgrounds,
    }
    save_users(users_db)

    return UserResponse(user_id=user_id, username=user_data.username, email=user_data.email)

@app.post("/login", response_model=Token)
async def login(user_data: UserLogin):
    user = next((u for u in users_db.values() if u["username"] == user_data.username), None)
    if not user or not verify_password(user_data.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    token = create_access_token({"sub": user["user_id"]})
    return Token(access_token=token, token_type="bearer", user_id=user["user_id"])

# === BACKGROUNDS ===
@app.get("/backgrounds/{user_id}", response_model=BackgroundResponse)
async def get_backgrounds(user_id: str):
    if user_id not in users_db:
        raise HTTPException(status_code=404, detail="User not found")
    return {"backgrounds": users_db[user_id]["backgrounds"]}

@app.post("/upload_background/")
async def upload_background(user_id: str = Form(...), file: UploadFile = File(...)):
    if user_id not in users_db:
        raise HTTPException(status_code=404, detail="User not found")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="Only image files allowed")

    user_dir = os.path.join(USERS_DIR, user_id)
    os.makedirs(user_dir, exist_ok=True)

    path = os.path.join(user_dir, file.filename)
    with open(path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    rel = f"/users/{user_id}/{file.filename}"
    if rel not in users_db[user_id]["backgrounds"]:
        users_db[user_id]["backgrounds"].append(rel)
        save_users(users_db)

    return {"message": "Background uploaded", "path": rel}

@app.get("/users/{user_id}/{filename}")
async def get_user_file(user_id: str, filename: str):
    path = os.path.join(USERS_DIR, user_id, filename)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path)

# === FRONTEND ===
FRONTEND_DIR = os.path.join(CURRENT_DIR, "..", "frontend")
AUTH_DIR = os.path.join(FRONTEND_DIR, "auth")
SEGMENT_DIR = os.path.join(FRONTEND_DIR, "segmentation")
PRIVACY_DIR = os.path.join(CURRENT_DIR, "..", "privacy")

app.mount("/users",        StaticFiles(directory=USERS_DIR),        name="users")
app.mount("/static",       StaticFiles(directory=STATIC_DIR),       name="static")
app.mount("/auth",         StaticFiles(directory=AUTH_DIR, html=True), name="auth")
app.mount("/segmentation", StaticFiles(directory=SEGMENT_DIR, html=True), name="segmentation")
app.mount("/privacy",      StaticFiles(directory=PRIVACY_DIR),      name="privacy")
app.mount("/",             StaticFiles(directory=AUTH_DIR, html=True), name="root")

