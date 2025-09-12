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
with the content of the file.

```json
{
    "type": "file_opened",
    "path": "TASKS.md",
    "content": "Hello world"
}
```

When a file is closed, the server sends a `file_closed` event.

```json
{
    "type": "file_closed",
    "path": "TASKS.md"
}
```

When the file is updated by another client (or the contents on disk are changed externally),
the server sends a `file_updated` event.

```json
{
    "type": "file_updated",
    "path": "TASKS.md",
    "content": "Hello world"
}
```

When the file is updated by this client,
the server sends a `file_written` event including the new content
(which might differ from what was written if there is a merge with another client's changes)

```json
{
    "type": "file_written",
    "path": "TASKS.md",
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

The `open_file` opens a file - the server will send the content of the file,
and then send updates when the file is modified.

The path can start with @ to mean the committed version of a file,
so @TASKS.md refers to the latest version committed to git.

```json
{
    "type": "open_file",
    "path": "TASKS.md"
}
```

The `close_file` command closes a file - no further changes will be sent to the client
for this file.
Open and closes are refcounted for the connection so if you open a file twice,
you need to close it twice.
(The server will need to track the refcounts per connection, not globally,
so that if the connection drops, stale refcounts are not left over.
On reconnection all open files need to be reestablished.)

```json
{
    "type": "close_file",
    "path": "TASKS.md"
}
```

The `write_file` command is sent when the user has edited a file,
and the server should save the new content to disk.
The `last_content` field is the content of the file as last received from the server -
this allows the server to detect if the file has been modified by another client,
and intelligently merge the changes.

The server will respond with a `file_written` event with the new content.

```json
{
    "type": "write_file",
    "path": "TASKS.md",
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
    content: string,
} | {
    type: "file_updated",
    path: string,
    content: string,
} | {
    type: "file_written",
    path: string,
    content: string,
}

// file_closed events are consumed by FileSystem and not passed along
// error events are raised as exceptions.

enum FileSystemState {
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
}

class FileSystem {
    constructor(url: string) {
    }

    public async *openFile(path: string): AsyncGenerator<FileEvent> {
    }

    // Returns the new content of the file as merged by the server
    public async writeFile(path: string, content: string): Promise<string> {
    }

    public async commit(message: string): Promise<void> {
    }

    // Returns a function to remove the listener
    public addStateListener(listener: (state: FileSystemState) => void): () => void {
    }
}
```

We close a file by breaking out of the generator returned by openFile.

```
useEffect(() => {
    let isActive = true;

    let fileEventsIterator;

    const watchFile = async () => {
        try {
            const fs = new FileSystem("ws://localhost:8080");
            fileEventsIterator = fs.openFile(filename);

            for await (const event of fileEventsIterator) {
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

        if (fileEventsIterator) {
            fileEventsIterator.return();
        }
    };
}, [filename]);
```

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

 * When we are in a disconnected state
  - writeFile and commit fail with an exception.
  - openFile on a file that we have not already opened fails with an exception.
  -  openFile on an already open file succeeds, and a synthetic file_opened event is generated locally.
 * On reconnection, all open files are reopened, and the file_opened events are locally transformed into file_updated events, if the received content differs from the last received content

The FileSystem object also has the ability to add a listener for the state (disconnected, connecting, connected), that is used to indicate in the UI that the connection has been lost.

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

**Phase 6b: File Operations and Notifications** 🚧 TODO
- Implement openFile() with AsyncGenerator for real-time file events
- File reference counting and close_file operations
- Handle file_opened, file_updated, and file_closed events
- Real-time notification system for external file changes
- Basic file content caching for disconnection scenarios
- Unit tests for file watching and notification flows

**Phase 6c: Advanced Client Features** 🚧 TODO
- Client-side file synchronization algorithm (standard mode and during-save mode)
- Automatic reconnection handling with exponential backoff
- File state synchronization on reconnect using cached content
- Advanced error handling and connection state management
- Comprehensive error recovery and retry mechanisms
- Expand unit test coverage for all advanced client functionality

**Phase 6d: React Integration** 🚧 TODO
- Integrate TypeScript FileSystem with React application
- Create React hooks for file operations (useFile, useFileSystem)
- Replace existing /api/files/TASKS.md REST API usage with WebSocket protocol
- Implement real-time collaborative editing support
- Handle UI state updates from file_updated events
- Error boundary and loading state management
- Integration testing with the full stack
