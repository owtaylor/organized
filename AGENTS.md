# Agent Context for the "Organized" Project

This document provides context for AI agents working on this project.

## Project Goal

The primary goal is to build a personal organization application to manage notes, tasks, and work history. The application will use an AI agent to help process information from various sources (audio notes, Git activity, Jira) and automate tasks like generating status reports.

## Project Structure

-   `src/`: Contains the core Python codebase for the backend server and agentic workflows.
    -   `organized/main.py`: The main FastAPI application file.
-   `ui/`: Contains the React/TypeScript frontend application.
-   `pyproject.toml`: Defines the Python project dependencies and configuration. Managed by `uv`.
-   `package.json`: Defines the Node.js project dependencies and scripts for the UI.
-   `~/.local/share/organized/main`: The default location for the local git repository that stores the user's data (`TASKS.md`).
-   `~/.config/organized/config.yaml`: The location for the application's configuration, including API keys.

## Data Schema

The core data is stored in `TASKS.md` in the git repository. The schema is as follows:

```markdown
## Project Name

Project description.

### Major Task

Description of the major task.

★ YYYY-MM-DD: A note or update related to the major task.

- [ ] A subtask.
    + YYYY-MM-DD: Work history for the subtask.
- [ ] ⏫ High priority subtask.
- [ ] ⬆ Medium priority subtask.
- [x] Completed subtask (✅ YYYY-MM-DD)
```

## Key Technologies

-   **Backend:** Python with FastAPI.
-   **Frontend:** React with TypeScript.
-   **Python Package Manager:** `uv`
-   **Markdown Editor:** MDXEditor
-   **Agent Framework:** BeeAI
-   **Data Sync:** `rclone` for syncing audio notes from Google Drive.
-   **Version Control:** Git is used to track changes to the data files.
