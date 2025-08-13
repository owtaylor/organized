from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from . import notes
from .tasks import ensure_git_repo, read_tasks_file, write_tasks_file

app = FastAPI()


@app.on_event("startup")
async def startup_event():
    """
    On startup, create the git checkout directory if it doesn't exist and initialize a git repository.
    """
    ensure_git_repo()


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
