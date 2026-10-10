"""Static host for the built app. All compute is client-side; this process
exists so the editor can run as a service with the standard /health contract."""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist"

app = FastAPI()


@app.get("/health")
def health():
    return {"ok": True, "checks": {}}


# Mount whichever static directories the build emitted (assets, and the
# vendored g-system under g/). A name that no longer exists must not stop
# the process: the spa route below serves any file under dist regardless.
for sub in ("assets", "g"):
    if (DIST / sub).is_dir():
        app.mount(f"/{sub}", StaticFiles(directory=DIST / sub), name=sub)


@app.get("/{path:path}")
def spa(path: str):
    candidate = DIST / path
    if path and candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(DIST / "index.html")
