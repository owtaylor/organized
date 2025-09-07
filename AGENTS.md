# Agent Context for the "Organized" Project

This document provides context for AI agents working on this project.

## Project Goal

The primary goal is to build a personal organization application to manage notes, tasks, and work history. The application will use an AI agent to help process information from various sources (audio notes, Git activity, Jira) and automate tasks like generating status reports.

## Project Structure

-   `src/`: Contains the core Python codebase for the backend server and agentic workflows.
    -   `organized/main.py`: The main FastAPI application file.
-   `ui/`: Contains the React/TypeScript frontend application, built with Vite and styled with Tailwind CSS.
    - `vite.config.ts`: Vite configuration file.
    - `tailwind.config.js`: Tailwind CSS configuration file.
    - `package.json`: Defines the Node.js project dependencies and scripts for the UI.
-   `pyproject.toml`: Defines the Python project dependencies and configuration. Managed by `uv`.
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
-   **Frontend:** React with TypeScript, Vite, and Tailwind CSS.
-   **Python Package Manager:** `uv`
-   **Markdown Editor:** MDXEditor
-   **Agent Framework:** BeeAI
-   **Data Sync:** `rclone` for syncing audio notes from Google Drive.
-   **Version Control:** Git is used to track changes to the data files.

## Development

### Running the app

*Do not* attempt to start backend or frontend servers after making changes - assume that the user is running them separately

### Code Formatting

To reformat Python code, run the following command from the project root:
```bash
uv run ruff check --fix
```

To reformat frontend code, navigate to the `ui/` directory and run:
```bash
npm run prettier-write
```

### Commit Messages
- Commit messages should aid **drive-by reviewers with limited context**.
  Assume the reader does not know the project well.
- Write commit messages in the tense that reflects the state of the project
  **just before** the commit is applied. When discussing the old behavior,
  treat it as the current behavior, and when discussing the changes treat
  them as new behavior.
- Format:
  - **First line**: a concise summary of the change being made with a short
    prefix (`project:`, `cli:`, `debuginfo:`, etc.).  Make the prefix all
    lowercase, but capitalize the first word of the summary.  If you don't know
    what prefix to use, run `git log --pretty=online FILE` and see the prefixes
    that were used previously.
  - **Body of commit**: 2-3 short natural language paragraphs that: summarize the code
    being changed (not the change itself), explain the problem with the existing
    state of affairs, and describe how the problem is solved by the commit.
- The summary line should be around 60 characters long
- All other paragraphs should wrap at 68 characters
- Reserve the demonstrative determiner "this" for the commit itself. Use "that"
or other options to refer to anything else.
