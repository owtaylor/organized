from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from . import notes
from .chat import router as chat_router
from .files import router as files_router, get_file_system
from .tasks import read_tasks_file, write_tasks_file


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan context manager to handle startup and shutdown."""
    # Get the file system instance (respecting dependency overrides)
    if get_file_system in app.dependency_overrides:
        file_system = app.dependency_overrides[get_file_system]()
    else:
        file_system = get_file_system()
    
    # Start file watching
    async with file_system.watch_files():
        yield
    # Shutdown: cleanup is handled automatically by the context manager


app = FastAPI(lifespan=lifespan)

# Include routers
app.include_router(chat_router)
app.include_router(files_router)


@app.get("/api/files/TASKS.md", response_class=PlainTextResponse)
async def get_tasks_file(committed: bool = False):
    """
    Reads the content of TASKS.md from the git repository.
    """
    return read_tasks_file(committed)


@app.post("/api/files/TASKS.md")
async def update_tasks_file(request: Request):
    """
    Writes content to TASKS.md in the git repository.
    """
    new_content = (await request.body()).decode()
    write_tasks_file(new_content)
    return {"message": "File updated successfully"}


@app.get("/api/notes/list")
async def list_notes():
    return notes.get_notes_list()


@app.get("/api/notes/sync")
async def sync_notes():
    return await notes.sync_notes()


@app.get("/api/notes/{note_hash}", response_class=PlainTextResponse)
async def get_note(note_hash: str):
    return notes.get_note_by_hash(note_hash)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
