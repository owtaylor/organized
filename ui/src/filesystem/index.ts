import {
  ServerEvent,
  ClientCommand,
  ConnectionClosedError,
  FileEvent,
  FileSystemState,
  FileSystemError,
  WriteFileCommand,
  CommitCommand,
  FileWrittenEvent,
  CommittedEvent,
  OpenFileCommand,
  CloseFileCommand,
} from "./types.js";

export type { FileEvent, FileSystemState };
export { FileSystemError };

type StateListener = (state: FileSystemState) => void;

interface PendingCommand {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
}

interface FileOpener {
  eventQueue: FileEvent[];
  pendingPromise: Promise<void> | null;
  resolvePending: (() => void) | null;
}

interface OpenFile {
  path: string;
  refCount: number;
  lastContent: string;
  opening: Promise<void> | null; // Promise that resolves when file is opened, null when open
  openers: Set<FileOpener>; // Each generator gets its own opener with separate event queue
}

class FileSystem {
  private ws: WebSocket | null = null;
  private url: string;
  private state: FileSystemState = FileSystemState.DISCONNECTED;
  private stateListeners: Set<StateListener> = new Set();
  private pendingCommands: PendingCommand[] = []; // FIFO queue for command responses
  private openFiles: Map<string, OpenFile> = new Map(); // Track open files and their generators

  constructor(url: string) {
    this.url = url;
  }

  private setState(newState: FileSystemState) {
    if (this.state !== newState) {
      this.state = newState;
      this.stateListeners.forEach((listener) => listener(newState));
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.state === FileSystemState.CONNECTED) {
        resolve();
        return;
      }

      this.setState(FileSystemState.CONNECTING);

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.setState(FileSystemState.CONNECTED);
          resolve();
        };

        this.ws.onclose = () => {
          this.setState(FileSystemState.DISCONNECTED);
          this.ws = null;
          // Reject all pending commands
          this.pendingCommands.forEach(({ reject }) => {
            reject(new ConnectionClosedError("Connection closed"));
          });
          this.pendingCommands.length = 0;
        };

        this.ws.onerror = (event) => {
          this.setState(FileSystemState.DISCONNECTED);
          this.ws = null;
          reject(
            new FileSystemError(
              "WebSocket connection failed",
              undefined,
              event as any,
            ),
          );
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.setState(FileSystemState.DISCONNECTED);
        reject(
          new FileSystemError(
            "Failed to create WebSocket",
            undefined,
            error as Error,
          ),
        );
      }
    });
  }

  private handleMessage(data: string) {
    try {
      const event: ServerEvent = JSON.parse(data);

      // Handle file events that should be sent to generators
      if (
        event.type === "file_opened" ||
        event.type === "file_updated" ||
        event.type === "file_written"
      ) {
        this.handleFileEvent(event as FileEvent);

        // file_opened and file_written are also responses to commands
        if (event.type === "file_updated") {
          return;
        }
      }

      // All other events are responses to commands - handle FIFO
      const pendingCommand = this.pendingCommands.shift();
      if (!pendingCommand) {
        console.warn("Received server event but no pending command:", event);
        return;
      }

      if (event.type === "error") {
        pendingCommand.reject(new FileSystemError(event.message, event.path));
      } else {
        pendingCommand.resolve(event);
      }
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
      // Reject the first pending command if parsing fails
      const pendingCommand = this.pendingCommands.shift();
      if (pendingCommand) {
        pendingCommand.reject(
          new FileSystemError(
            "Failed to parse server response",
            undefined,
            error as Error,
          ),
        );
      }
    }
  }

  private handleFileEvent(event: FileEvent) {
    console.log(`Handling file event: ${event.type} for ${event.path}`);
    const openFile = this.openFiles.get(event.path);
    if (!openFile) {
      console.warn(`Received file event for unopened file: ${event.path}`);
      return; // File not open, ignore event
    }

    // Update cached content
    openFile.lastContent = event.content;

    // Add event to all opener queues and resolve pending promises
    console.log(`Distributing event to ${openFile.openers.size} openers`);
    for (const opener of openFile.openers) {
      console.log(`Adding event to opener queue: ${opener.id}`);
      const wasEmpty = opener.eventQueue.length === 0;
      opener.eventQueue.push(event);

      // If queue was empty and we have a pending promise, resolve it
      if (wasEmpty && opener.resolvePending) {
        opener.resolvePending();
        opener.resolvePending = null;
        // Note: pendingPromise will be set to null in createFileGenerator
      }
    }
  }

  private async sendCommand(command: ClientCommand): Promise<ServerEvent> {
    if (this.state !== FileSystemState.CONNECTED) {
      await this.connect();
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new FileSystemError("WebSocket not connected");
    }

    return new Promise<ServerEvent>((resolve, reject) => {
      // Add to FIFO queue before sending
      this.pendingCommands.push({ resolve, reject });

      try {
        this.ws!.send(JSON.stringify(command));
      } catch (error) {
        // Remove from queue if send fails
        this.pendingCommands.pop();
        reject(
          new FileSystemError(
            "Failed to send command",
            undefined,
            error as Error,
          ),
        );
      }
    });
  }

  async writeFile(
    path: string,
    lastContent: string,
    newContent: string,
  ): Promise<string> {
    const command: WriteFileCommand = {
      type: "write_file",
      path,
      last_content: lastContent,
      new_content: newContent,
    };

    const event = await this.sendCommand(command);

    if (event.type === "file_written") {
      return (event as FileWrittenEvent).content;
    }

    throw new FileSystemError(`Unexpected response type: ${event.type}`);
  }

  async commit(message: string): Promise<void> {
    const command: CommitCommand = {
      type: "commit",
      message,
    };

    const event = await this.sendCommand(command);

    if (event.type === "committed") {
      return; // Success
    }

    throw new FileSystemError(`Unexpected response type: ${event.type}`);
  }

  addStateListener(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // Immediately call with current state
    listener(this.state);

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  getState(): FileSystemState {
    return this.state;
  }

  async *openFile(path: string): AsyncGenerator<FileEvent> {
    // Check if file is already open or opening
    let openFile = this.openFiles.get(path);

    if (!openFile) {
      // Create the open file entry immediately to handle concurrency
      let resolveOpening: () => void;
      let rejectOpening: (error: Error) => void;

      const openingPromise = new Promise<void>((resolve, reject) => {
        resolveOpening = resolve;
        rejectOpening = reject;
      }).catch((error) => {
        // Prevent unhandled rejection
      });

      openFile = {
        path,
        refCount: 1,
        lastContent: "",
        opening: openingPromise,
        openers: new Set(),
      };
      this.openFiles.set(path, openFile);

      // File not open yet - need to open it
      // Connect if not already connected (just like writeFile and commit do)
      if (this.state !== FileSystemState.CONNECTED) {
        await this.connect();
      }

      // Send open_file command
      const command: OpenFileCommand = {
        type: "open_file",
        path,
      };

      try {
        const event = await this.sendCommand(command);

        if (event.type !== "file_opened") {
          const error = new FileSystemError(
            `Unexpected response type: ${event.type}`,
          );
          rejectOpening!(error);
          this.openFiles.delete(path);
          throw error;
        }

        // File successfully opened
        openFile.opening = null;
        openFile.lastContent = event.content;

        resolveOpening!();
      } catch (error) {
        rejectOpening!(error as Error);
        this.openFiles.delete(path);
        throw error;
      }
    } else if (openFile.opening) {
      // File is currently being opened - wait for it to complete
      openFile.refCount++;

      await openFile.opening;
    } else {
      // File already open - increment ref count
      openFile.refCount++;
    }

    // Create opener for this generator
    const opener: FileOpener = {
      eventQueue: [],
      pendingPromise: null,
      resolvePending: null,
    };

    openFile.openers.add(opener);

    // Always use a synthetic file_opened event for simplicity. Note that
    // this synthetic event might compress the initial file_opened event
    // and subsequent file_updated events into a single event

    opener.eventQueue.push({
      type: "file_opened",
      path,
      content: openFile.lastContent,
    });

    try {
      yield* this.createFileGenerator(opener);
    } finally {
      // Clean up when generator is closed
      await this.closeFileOpener(path, opener);
    }
  }

  private async *createFileGenerator(
    opener: FileOpener,
  ): AsyncGenerator<FileEvent> {
    while (true) {
      // Get any events from the queue
      const events = [...opener.eventQueue];
      opener.eventQueue.length = 0; // Clear the queue

      console.log(`Generator: Found ${events.length} events in queue`);

      // Yield any events we have
      for (const event of events) {
        console.log(`Generator: Yielding event ${event.type}`);
        yield event;
      }

      // If we yielded events, continue to check for more immediately
      if (events.length > 0) {
        continue;
      }

      // No events available, wait for more
      if (this.state === FileSystemState.DISCONNECTED) {
        throw new FileSystemError("Connection lost");
      }

      // Set up promise for next batch of events
      opener.pendingPromise = new Promise<void>((resolve) => {
        opener.resolvePending = resolve;
      });

      console.log("Generator: Waiting for new events...");
      await opener.pendingPromise;
      opener.pendingPromise = null;
    }
  }

  private async closeFileOpener(path: string, opener: FileOpener) {
    const openFile = this.openFiles.get(path);
    if (!openFile) {
      return;
    }

    // Remove opener from set
    openFile.openers.delete(opener);

    // Decrement ref count
    openFile.refCount--;

    // If this was the last reference, close the file
    if (openFile.refCount === 0) {
      this.openFiles.delete(path);

      // Send close_file command if connected
      if (this.state === FileSystemState.CONNECTED) {
        const command: CloseFileCommand = {
          type: "close_file",
          path,
        };

        this.sendCommand(command).catch((error) => {
          if (!(error instanceof ConnectionClosedError)) {
            console.warn("Failed to send close_file command:", error);
          }
        });
      }
    }
  }

  disconnect(): void {
    // Reject all pending opener promises
    for (const openFile of this.openFiles.values()) {
      for (const opener of openFile.openers) {
        if (opener.resolvePending) {
          opener.resolvePending();
        }
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState(FileSystemState.DISCONNECTED);
  }
}

export default FileSystem;
