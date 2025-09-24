= Organized File System Design

Storage for Organized is a filesystem directory on disk.
There is a specific structure within the directory
(with a TASKS.md, a notes/ directory, and so forth),
however, at the lowest layer we deal with it in an uninterpreted fashion.

== Protocol

The protocol for accessing the filesystem is over a websocket,
with a protocol consisting of the server sending events as json objects,
and the client sending commands, also as json objects.

For each command, the server will send *either* a response or an error event.
(We don't include any sort of serial number in the commands, and simply count on
the commands and responses being in order.)

=== Server events

When a file is first opened, the server sends a `file_opened` event,
with the content of the file and the handle used for this file.

```json
{
    "type": "file_opened",
    "path": "TASKS.md",
    "handle": "1",
    "content": "Hello world"
}
```

When a file is closed, the server sends a `file_closed` event.

```json
{
    "type": "file_closed",
    "handle": "1"
}
```

When the file is updated by another client (or the contents on disk are changed externally),
the server sends a `file_updated` event to all handles for that file except the one that caused the change.

```json
{
    "type": "file_updated",
    "handle": "1",
    "content": "Hello world"
}
```

When the file is updated by this client,
the server sends a `file_written` event to the handle that made the write, and `file_updated` events
to all other handles for the same file. The content might differ from what was written if there is a merge with another client's changes.

```json
{
    "type": "file_written",
    "handle": "1",
    "content": "Hello world"
}
```

When a git commit succeeds, the server sends a `committed` event
(followed by a `file_updated` event for each open `@file` that was changed by the commit)

```json
{
    "type": "committed",
}
```

If a command fails, the server sends an error event:

```json
{
    "type": "error",
    "path": "TASKS.md",
    "message": "File not found"
}
```

=== Client commands

The `open_file` opens a file with a specific handle - the server will send the content of the file,
and then send updates when the file is modified. Each `open_file` command must have a unique handle
per connection. Multiple handles can be opened for the same file.

The path can start with @ to mean the committed version of a file,
so @TASKS.md refers to the latest version committed to git.

```json
{
    "type": "open_file",
    "path": "TASKS.md",
    "handle": "1"
}
```

The `close_file` command closes a specific file handle - no further changes will be sent to the client
for this handle. Each handle can only be closed once.

```json
{
    "type": "close_file",
    "handle": "1"
}
```

The `write_file` command is sent when the user has edited a file,
and the server should save the new content to disk. The handle must refer to an open file.
The `last_content` field is the content of the file as last received from the server -
this allows the server to detect if the file has been modified by another client,
and intelligently merge the changes.

The server will respond with a `file_written` event for the writing handle, and `file_updated` events for all other handles.

```json
{
    "type": "write_file",
    "handle": "1",
    "last_content": "Hello",
    "new_content": "Hello world"
}
```

The `commit` command is sent when the user wants to commit the current state of the repository.
All files are committed unless they are explicitly excluded by .gitignore.

```json
{
    "type": "commit",
    "message": "Add hello world\n\nThis is a test commit"
}
```

== Javascript client API

The client API is a wrapper around the websocket connection.

```ts
type FileEvent = {
    type: "file_opened",
    path: string,
    handle: string,
    content: string,
} | {
    type: "file_updated",
    handle: string,
    content: string,
} | {
    type: "file_written",
    handle: string,
    content: string,
}

// file_closed events are consumed by FileSystem and not passed along
// error events are raised as exceptions.

enum FileSystemState {
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    RECONNECT_WAIT,
}

interface File {
    // Get async generator for file events
    getEvents(): AsyncGenerator<FileEvent>;

    // Write to the file - client must provide the old content for proper merging
    writeFile(oldContent: string, newContent: string): Promise<string>;

    // Close the file handle (explicit cleanup) - fire and forget
    close(): void;

    // Get the path for this file
    readonly path: string;
}

class FileSystem {
    constructor(url: string) {
    }

    public openFile(path: string): File {
    }

    public async commit(message: string): Promise<void> {
    }

    // Manual connection method - useful for "Connect Now" UI in RECONNECT_WAIT state
    public async connectNow(): Promise<void> {
    }

    // Get current connection state
    public getState(): FileSystemState {
    }

    // Returns a function to remove the listener
    public addStateListener(listener: (state: FileSystemState) => void): () => void {
    }

    // Disconnect and stop automatic reconnection
    public disconnect(): void {
    }
}
```

We close a file by calling the close() method on the File object.


```
useEffect(() => {
    let isActive = true;
    let file;

    const watchFile = async () => {
        try {
            const fs = new FileSystem("ws://localhost:8080");
            file = fs.openFile(filename);

            for await (const event of file.getEvents()) {
                // Only update state if this effect is still the active one.
                if (isActive) {
                    setMarkdown(event.content);
                }
            }
        } catch (error) {
            // It's good practice to handle errors.
            if (isActive) {
                console.error("Error watching file:", error);
            }
        }
    };

    watchFile();

    // The cleanup function, called when the component unmounts
    // or when `filename` changes.
    return () => {
        isActive = false;

        if (file) {
            file.close();
        }
    };
}, [filename]);
```

== React component architecture

The React editor uses a clean component architecture with direct Monaco editor integration:

**Main Editor Component**: The `<Editor path="some/file.txt"/>` component provides a floating toolbar to switch between edit/diff/preview modes and manages the overall editor state. It gets the FileSystem from React context and creates an EditorController instance.

**EditorController**: This class handles the core synchronization logic between the filesystem protocol and Monaco editor models. It creates and manages Monaco ITextModel instances for both working and committed file versions, automatically syncing content changes with the filesystem. The controller provides auto-save functionality with a 10-second debounce timer and manages the three-way content split (local/remote/committed).

**Component Structure**: The editor is split into specialized components in `src/components/editor/`:
- **CodeEditor**: Creates and manages a Monaco standalone code editor, directly setting the working model
- **DiffEditor**: Creates a Monaco diff editor comparing committed vs working models
- **MarkdownPreview**: Renders markdown content using ReactMarkdown, listening to model changes

**State Management**: The architecture avoids re-rendering on every keystroke by managing editor content through Monaco models rather than React state. Only the markdown preview mode requires React state updates for content rendering. 

== Details of client synchronization algorithm

When editing a file, the client keeps a copy of the last version received from the server.

Two different modes:

**Standard mode**

When a new version is received from the server, any local changes are rebased
onto the new version (using diff-match-patch-es):

```ts
editorContent = patchApply(newContent, patchMake(lastReceivedContent, editorContent))
```

If any changes can't be applied, they are just discarded.

**During a save**

After the client has sent a `write_file` command but before the response is received,
if any new versions are received from the server, they are simply ignored - the server
is responsible for merging the changes. Once the response is received, any local
changes since the write_file was sent are rebased onto the new version:

```ts
 editorContent = patchApply(newContent, patchMake(sentContent, editorContent))
```

Where `sentContent` is the `content` field of the `write_file` command,
and `newContent` is the `content` field of the `file_written` event.

Again, if any changes can't be applied, they are just discarded.

== Handling disconnection and reconnection

Connection and reconnection to the server is handled inside the FileSystem object, as follows:

 * The initial state of the FileSystem object is DISCONNECTED
 * When we attempt to connect, the state changes to CONNECTING and then if it succeeds, CONNECTED
 * A promise member in the fs object is used to make multiple simultaneous calls to connect() work properly
 * If a connection attempt fails, or the socket is disconnected:
   - State changes to RECONNECT_WAIT if there are open files
   - State changes to DISCONNECTED if there are no open files
 * In the DISCONNECTED or RECONNECT_WAIT state, the connection is attempted:
    - Automatically, if writeFile()/commit()/openFile() are called
    - Manually, if fs.connectNow() is called [meant to be hooked up to a UI "connect now" for the RECONNECT_WAIT state]
 * In the RECONNECT_WAIT state, the connection is also attempted to be reconnected automatically with exponential back-off (starting 5s, doubling, limit 5m)

The following additional behaviors exist:

 * If the connection inside writeFile/commit/openFile fails, the operation fails with an exception
 * getEvents() can only be called once per file - subsequent calls throw an error
 * close() is fire-and-forget - it doesn't wait for server confirmation
 * On reconnection, file_open commands are sent only for files that have been successfully opened before (not files still in the opening process), and subsequent file_opened events are locally transformed into file_updated events if the received content differs from the last received content

The FileSystem object also has the ability to add a listener for the state (disconnected, connecting, reconnect_wait, connected), that is used to indicate in the UI that the connection has been lost.

== Server internals

There is a singleton FileSystem object (in file_system.py),
which is responsible for managing all file system operations.

For each opened file, there is a File object (in file_system.py),
which tracks: the file contents, and how many times it has been opened,
and a mtime for the file.

```python
@abc
class FileSystemWatcher:
    @abstractmethod
    def on_file_change(self, filename, content):
        pass

class FileSystem:
    def __init__(self):
        self.files = {}  # Maps filenames to File objects
        ...

    def open_file(self, filename):
        ...

    def close_file(self, filename):
        ...

    def write_file(self, filename, last_content, content, exclude_watcher: Watcher = None) -> str:
        ...

    def edit_file(self, filename, edit_function: Function[str, str]):
        ...

    def add_watcher(self, watcher):
        ...

    def remove_watcher(self, watcher):
        ...

    def commit(self, commit_message):
        ...
```

=== Merging changes

When the write_file() API is called, the differences between `last_content` and `content`
are calculated using the diff-match-patch library and applied to the the current content.

```python
new_content = patch_apply(current_content, patch_make(last_content, content))
```

(in the normal case, last_content is identical to current_content, so this is just `new_content = content`.)

If changes can't be applied, then they are just discarded. The result is then written to disk
and sent back in a `file_written` event.

=== Writing files to disk

Writing a file is done atomically:

1. Write the contents to a temporary name
2. fstat the file to get the mtime
3. Rename the file to the final name
4. Update the current content and mtime

If this fails (e.g., an out-of-disk-space error),
the temporary file is deleted and an exception is raised and no change is made to the in-memory content.
So, `edit_file()` would look something like:

```python
   def edit_file(self, filename, edit_function):
      opened = False
      try:
          self.open_file(filename)
          opened = True
          new_content = edit_function(self.files[filename].content)
          self._write_file(filename, new_content)
      finally:
          if opened:
             self.close_file(filename)
```

=== Reacting to file changes

The watchfiles module is used to monitor the file system for changes -
a single recursive watch is created to watch for changes to the entire repository.
When a change is detected:

1. stat the file to get the mtime
2. if it's different than the current stored mtime
   a. read the file and update the content and the mtime
   b. notify all added FileSystemWatcher objects of the change

== Git handling

To read the committed versions of files, we read and track changes to .git/HEAD and the ref it points to.

When the ref changes, we read open files from that revision using `git cat-file blob <rev>:<path>`
and notify if necessary.


== Implementation Plan

**Phase 1: Basic FileSystem** ✅ COMPLETED
- Core FileSystem class with git repository validation
- File opening/closing with reference counting
- Atomic file writing with proper error handling
- FileSystemWatcher interface and notification system
- Path traversal protection and security validation
- Comprehensive test suite

**Phase 2: File System Watching** ✅ COMPLETED
- Integration with watchfiles module for monitoring changes
- Automatic detection of external file modifications
- Proper handling of file deletions and moves
- Async context manager `watch_files()` for clean resource management
- Smart filtering (tracked files only, ignores .git directory)
- Robust error handling and mtime-based change detection
- Comprehensive test suite with async-aware MockWatcher
- TODO: Investigate rare test flake in subdirectory file watching (test_watch_files_handles_subdirectory_files)

**Phase 3: Content Merging** ✅ COMPLETED
- diff-match-patch integration for intelligent conflict resolution
- Three-way merging when multiple clients modify the same file
- Proper handling of merge failures
- TODO: Investigate word-mode diffs (https://github.com/google/diff-match-patch/wiki/Line-or-Word-Diffs) to improve merge quality and avoid character-level weirdness

**Phase 4: Git Integration** ✅ COMPLETED
- Support for @file paths (committed versions) - implemented in FileSystem.open_file()
- Git commit functionality with proper staging - implemented in FileSystem.commit()
- Manual HEAD resolution and tracking - implemented with _resolve_head_commit()
- Real-time HEAD change detection and @file updates when commits/branches change
- Integration with file watching system to detect .git directory changes

**Phase 5: WebSocket Protocol** ✅ COMPLETED
- WebSocket server implementation using FastAPI router pattern - implemented in files.py
- JSON protocol for file operations and events - full protocol support with comprehensive test suite
- Connection management using Connection class as context manager and FileSystemWatcher
- Per-connection file reference tracking with automatic cleanup on disconnect
- Real-time file_updated events from external file system changes
- Integration with main FastAPI app using lifespan function for file watching
- Comprehensive test suite (14 test cases) covering all protocol features

**Phase 6a: Basic TypeScript Client** ✅ COMPLETED
- TypeScript type definitions for protocol messages - complete protocol types in types.ts
- Vitest testing framework setup with jsdom environment and test scripts
- jest-websocket-mock integration for WebSocket testing with proper configuration
- Basic FileSystem class with WebSocket connection management (connect/disconnect) 
- FIFO command queue with proper response handling for ordered operations
- Connection state tracking with listener support (CONNECTING/CONNECTED/DISCONNECTED)
- Core operations: writeFile() and commit() with robust error handling
- Comprehensive unit test suite (13 tests) covering all implemented functionality
- Mock WebSocket testing for isolated client logic testing

**Phase 6b: File Operations and Notifications** ✅ COMPLETED
- ✅ COMPLETED: Comprehensive test cases designed for all Phase 6b functionality
  - openFile() AsyncGenerator tests with Promise.all pattern for proper error handling
  - File reference counting tests with multiple concurrent opens
  - File event handling tests (file_opened, file_updated, file_closed)
  - Real-time notification system tests for multiple files
  - File content caching tests for disconnection scenarios
- ✅ COMPLETED: Core implementation structure
  - Added FileOpener interface with separate event queues per generator
  - Added OpenFile interface with reference counting and opening promise
  - Implemented handleFileEvent() for distributing events to all openers
  - Added openFiles Map to track all open files and their generators
- ✅ COMPLETED: openFile() AsyncGenerator implementation
  - Basic structure implemented with async generator pattern
  - Connection handling added (calls connect() like writeFile/commit)
  - File opening with promise-based concurrency protection
  - Synthetic file_opened events for subsequent opens
  - Event distribution system with per-opener queues

**Phase 6c: Connected states and reconnection** ✅ COMPLETED
- Added RECONNECT_WAIT state and proper state transitions based on open files
- Connection promise management prevents multiple simultaneous connect() calls
- Exponential backoff reconnection (5s start, doubling, 5m limit)
- File reestablishment on reconnect with content change detection
- Public connectNow() method and comprehensive test coverage (8 tests)

**Phase 7: Protocol and Client Revision** ✅ COMPLETED
- ✅ Updated tests/test_files_websocket.py for handle-based protocol
- ✅ Updated the Python server implementation with handle support
- ✅ Created new TypeScript client tests for File object API
- ✅ Implemented new TypeScript client with File object interface
- ✅ Incorporated protocol changes into main FILESYSTEM_DESIGN.md documentation

**Phase 8: React Integration**

**Phase 8a: Basic FileSystem Integration** ✅ COMPLETED
- ✅ COMPLETED: FileSystem Context Provider (`ui/src/contexts/FileSystemContext.tsx`)
  - Single FileSystem instance shared across React app via context
  - Connection state tracking and listener management
  - WebSocket URL configuration (`ws://localhost:8080/ws`)
- ✅ COMPLETED: EditorController Implementation (`ui/src/controllers/EditorController.ts`)
  - Type-safe discriminated union for editor state (code/diff/none)
  - Separate `setCodeEditor()` and `setDiffEditor()` methods for Monaco integration
  - Three-way content split: local/remote/committed contents tracking
  - Auto-save with 10-second debounce timer
  - Dual file handle management (working file + `@file` committed version)
  - Simple last-wins synchronization (full algorithm in Phase 8c)
- ✅ COMPLETED: Complete Editor Component Restructuring (`ui/src/Editor.tsx`)
  - New path-based API: `<Editor path="TASKS.md" />` instead of content props
  - Internal EditorController encapsulation - no external file management needed
  - Unmanaged Monaco editors following FILESYSTEM_DESIGN.md pattern (no keystroke re-renders)
  - Enhanced type safety with separate mount handlers for code vs diff editors
- ✅ COMPLETED: Aggressive App.tsx Simplification (`ui/src/App.tsx`)
  - Removed all HTTP-based file fetching and state management
  - Removed auto-save logic, markdown state, and change handlers
  - Clean separation: App handles navigation/layout, Editor handles file operations
  - Wrapped in FileSystemProvider for context access

**Phase 8b: Connection State & Polish** 🚧 TODO
- Add connection status UI component showing FileSystem state
- "Connect Now" button for RECONNECT_WAIT state
- Integration with react-hot-toast for connection notifications
- Enhanced error handling and graceful degradation when disconnected

**Phase 8c: Full Synchronization Algorithm** 🚧 TODO
- Add diff-match-patch dependency (`npm install diff-match-patch @types/diff-match-patch`)
- Implement advanced EditorController synchronization:
  - Standard mode: rebase local changes onto server updates using diff-match-patch
  - Save mode: ignore updates during save, then rebase after file_written response
  - Graceful merge conflict handling with change discarding
- Replace simple last-wins behavior with intelligent three-way merging

**Phase 8d: Testing & Refinement** 🚧 TODO
- Unit tests for EditorController synchronization logic
- Integration tests for React components with FileSystem
- Performance optimization and memory management
- Error boundary and recovery mechanisms
