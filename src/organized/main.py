import subprocess
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse
from pathlib import Path

from . import notes

app = FastAPI()

GIT_CHECKOUT_LOCATION = Path.home() / ".local" / "share" / "organized" / "main"
TASKS_FILE_PATH = GIT_CHECKOUT_LOCATION / "TASKS.md"


def extract_frontmatter(content):
    """
    Extracts YAML frontmatter from the content.
    """
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            return yaml.safe_load(parts[1]), parts[2].lstrip()
    return {}, content


@app.on_event("startup")
async def startup_event():
    """
    On startup, create the git checkout directory if it doesn't exist and initialize a git repository.
    """
    if not GIT_CHECKOUT_LOCATION.exists():
        GIT_CHECKOUT_LOCATION.mkdir(parents=True, exist_ok=True)

    if not (GIT_CHECKOUT_LOCATION / ".git").exists():
        subprocess.run(["git", "init"], cwd=GIT_CHECKOUT_LOCATION, check=True)


@app.get("/api/files/TASKS.md", response_class=PlainTextResponse)
async def get_tasks_file(committed: bool = False):
    """
    Reads the content of TASKS.md from the git repository.
    """
    if not TASKS_FILE_PATH.exists():
        return """## My First project

This is a description of my first project. It might be quite long.

### Major task in My First Project

This is the description of the major task.

★ 2025-07-13: I talked to somebody and found out an interesting "tidbit" that I want to appear in my next status report.

- [ ] Subtask in task
    + 2025-07-13: I did some work on this subtask
- [ ] ⏫ High priority subtask
- [ ] ⬆ Medium priority task
- [x] Completed subtask (✅ 2025-04-17)
- [x] Completed subtask with history
    + 2025-05-20 talked to someone about this
    + ✅ 2025-05-17

### Completed major task in My First Project (✅ 2025-06-10)

[...]

### Other
- [ ] This is a quick task not related to any major task

## My second project
[...]

## Other Work

- [ ] ⏫ This is a random import task not related to any project
"""

    if committed:
        try:
            content = subprocess.run(
                ["git", "show", "HEAD:TASKS.md"],
                cwd=GIT_CHECKOUT_LOCATION,
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        except subprocess.CalledProcessError:
            # Handle case where file doesn't exist in git history
            return ""
    else:
        content = TASKS_FILE_PATH.read_text()

    _, content = extract_frontmatter(content)
    return content


@app.post("/api/files/TASKS.md")
async def update_tasks_file(request: Request):
    """
    Writes content to TASKS.md in the git repository.
    """
    new_content = (await request.body()).decode()

    existing_frontmatter = {}
    if TASKS_FILE_PATH.exists():
        existing_frontmatter, _ = extract_frontmatter(TASKS_FILE_PATH.read_text())

    if existing_frontmatter:
        new_content = (
            "---\n" + yaml.dump(existing_frontmatter) + "---\n\n" + new_content
        )

    TASKS_FILE_PATH.write_text(new_content)
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
