This is a personal organization application to manage notes and tasks, and handle creating weekly status reports and quarterly updates. To manage the weekly status report task, it will need to keep track of work history and updates to tasks.

Some of the basic design priciples are:

- The notes, tasks, and work history are stored in markdown files that are updated manually and by an AI agent. The current state of the files represents the agreement between the user and the AI agent.
- Git is used to track changes to the file, and also (by pushing to a remote repository the backup mechanism.
  - The AI agent handles creating commit message, commiting and pushing; while the user (me) is fluent in Git, Git is a background mechanism and not a focus.
- The AI agent consumes a number of feeds of data to handle updates.
  - Audio notes that I'll record and upload to Google Drive. The app will download them and transcribe them (using the Gemini API)). Lists of names, projects, etc, will be provided to the transcription process to help accuracy.
  - Activity from Github, Gitlab, and Jira will also be fed in. This activity will include _my_ activity, but also activity from repositories and issues that are mentioned in the notes and tasks.

The structure of the application as I see it:

- There is a core Python codebase that handles:
  - Implementation of the agentic workflow
  - Tools for the agentic workflow
- The Python codebase runs as a local server process on my laptop.
- There is React/TSX frontend that runs in the browser(or an electron app) and provides a UI with:
  - Editing the markdown files - this should be primarily wysiwyg, to reduce context switching between editing the markdown and seeing how it looks (which is a waste of time)
  - Viewing summarized data (highest priority items)
  - Canned agent tasks (update from feeds, commit and push)
  - Chat with the agent. Probably the canned tasks should be represented in the chat history - this allows a UI convention where typically one chat session is one git commit - it might look like:
    - /update
    - <user edits the task list>
    - Please add reviewing github/me/myproject#124 to my task list
    - /done (commits and pushes)

Eventually other interfaces could include:

- CLI: 'oz add review github/me/myproject#124'
- vscode chat participant: "@oz add ..."
- greasemonkey webbrowser scripts for fast updates from JIRA/gitlab
- With the Python code on a server
  - Simplified mobile interface

Directory structure:

- src/ - Python source code (toplevel config in ./pyproject.toml)
- ui/ - React/TSX source code (toplevel config in web/package.json)

config.yaml:

```yaml
audio_notes:
  sync_command: "rclone sync gdrive:AudioNotes $dest"
gemini:
  api_key: "your_api_key_here"
github:
  api_key: "your_api_key_here"
jira:
  api_key: "your_api_key_here"
```

Some technical choices:

- There should be a default local git checkout in ~/.local/share/organized/main
- Config in ~/.config/organized/config.yaml - API keys are just inline in the config file
- Audio notes are synced from Google Drive by shelling out and running rclone. This is necessary because using the Google Drive API would require IT approval. (Eventually: use the google drive API)
- Use `uv` for managing tracking the virtual environment, setuptools for packaging.
- Use MDXEditor for markdown editing in the web. While it's a little clunky, it has the features we need.
- For agentic framework use BeeAI - I need to up my familiarity with it. As a stage 0 thing, we can run it's web UI in an iframe for the chat interface.

## Schema

For now, all the data will be stored in one file at the root of the git repository, called `TASKS.md`. It is stuctured as follows:

```
## My First project

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
```

## Audio Notes 

### Audio notes backend

* Audio notes are stored at ~/.local/share/organized/audio/
* This is synchronized from remote storage using audio_notes: sync_command from the config file. The filenames are whatever they are in the origin.
* The notes are transcribed into the notes/ folder in the repository. Files are named with the timestamp the audio was recorded in the format 2025-07-13-17:21:18.md
* Transcription is done by calling gemini. If present, a file in the repository ./CONTEXT.md is provided as context for the transcription - it is a markdown file that has information like names of people and names of projects.
* The date is extracted from the file by calling out to the mediainfo tool. As a shell command the extraction looks like:

       $ mediainfo --Output=JSON /path/to/file.m4a  | jq .media.track[0].Encoded_Date
       "2025-07-28 20:08:15 UTC"

  But the extraction from the JSON should be done in the code rather than using jq.

* The repository also has a notes.yaml file that looks like:

      - hash: 1234567890abcdef
        date: 2025-07-13-17:21:18
        title: Work on my project
        processed: false

  the hash field is the sha256sum of the audio file.
  the processed field indicates that the note has been processed by the agent and the TASKS.md file updated accordingly.

* There are the following routes in the API:
    GET /api/notes/list - returns the list of notes (notes.yaml in JSON form)
    GET /api/notes/<hash> - returns the transcribed note for the given hash
    GET /api/notes/sync. This does the following:
    - calls sync_command to sync the notes from the remote server
    - updates notes.yaml with the new notes. the title field is not yet provided.
    - for each note in notes.yaml (whether downloaded or not), if there is no transcription
      - calls out to gemini to transcribe the note
      - writes the transcription file
      - uses the first heading of the transcription as the title of the note (the transcription prompt should the model to add a toplevel heading with a brief summary of the contents of the note)

### Audio notes frontend design

The page should be updated so there are two tabs on the left (the chat window on the right is always shown) - one tab is "Tasks" with the current UI for the TASKS.md and one tab is "Notes" with the following UI: there is a list of notes on the left, and the transcription of the selected note on the right.

The list of notes is sorted by date, with the most recent note at the top. The list of notes should show the title of the note, and the date of the note.

The transcription is shown as rendered markdown. It is not editable - use remarkjs/react-markdown (new dependency) to render it.

A floating action button is overlayed at the lower right of the notes list (so only visible when you go to the notes tab). It uses the arrow-path heroicon and when triggered runs /api/notes/sync.


