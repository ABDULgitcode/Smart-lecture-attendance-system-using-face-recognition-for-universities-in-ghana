import hmac
import os

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile

from app.pipeline import MODEL_VERSION, analyze_image, analyze_pair

app = FastAPI(title="Lecture attendance face service", version="1.0")


def check_key(value: str | None):
    expected = os.environ.get("FACE_INTERNAL_KEY", "dev-face-key-change-me")
    given = value or ""
    if len(given) != len(expected) or not hmac.compare_digest(given, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health")
def health():
    return {"ok": True, "modelVersion": MODEL_VERSION}


@app.post("/analyze")
async def analyze(
    image: UploadFile = File(...),
    mode: str = Form("recognize"),
    x_internal_key: str | None = Header(default=None),
):
    check_key(x_internal_key)
    if mode not in {"enroll", "recognize"}:
        raise HTTPException(status_code=400, detail="Unknown mode")
    try:
        return analyze_image(await image.read(), mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/analyze-pair")
async def analyze_two(
    image1: UploadFile = File(...),
    image2: UploadFile = File(...),
    x_internal_key: str | None = Header(default=None),
):
    check_key(x_internal_key)
    try:
        return analyze_pair(await image1.read(), await image2.read())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
