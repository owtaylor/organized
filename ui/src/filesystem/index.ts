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
  File,
  FileOpenedEvent,
  FileUpdatedEvent,
} from "./types.js";

export type { FileEvent, FileSystemState, File };
export { FileSystemError };

type StateListener = (state: FileSystemState) => void;

interface PendingCommand {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
}

class FileImpl implements File {
  private eventQueue: FileEvent[] = [];
  private pendingResolver: (() => void) | null = null;
  private closed = false;
  private _lastContent = ""; // Last received content from server (not last delivered to client)
  private openPromise: Promise<void>;
  private hasBeenOpened = false;
  private getEventsCalled = false;

  constructor(
    private fileSystem: FileSystem,
    public readonly path: string,
    private handle: string,
  ) {
    // Start opening the file immediately
    this.openPromise = this.fileSystem
      ._openFile(path, handle)
      .catch((error) => {
        this.fileSystem._removeFile(handle);
        throw error;
      });
  }

  async *getEvents(): AsyncGenerator<FileEvent> {
    if (this.getEventsCalled) {
      throw new FileSystemError("getEvents() can only be called once per file");
    }
    this.getEventsCalled = true;

    // Wait for file to be opened first
    await this.openPromise;

    while (!this.closed) {
      // If we have queued events, yield the first one
      if (this.eventQueue.length > 0) {
        const event = this.eventQueue.shift()!;
        yield event;
        continue;
      }

      // If we're closed, stop
      if (this.closed) {
        break;
      }

      // Wait for the next event
      await new Promise<void>((resolve) => {
        this.pendingResolver = resolve;
      });
    }
  }

  // Add an event to this file's queue
  _addEvent(event: FileEvent) {
    if (this.closed) return;

    let processedEvent: FileEvent | null = event;

    // Smart event processing
    if (event.type === "file_opened") {
      if (!this.hasBeenOpened) {
        // First file_opened event - always deliver
        this.hasBeenOpened = true;
      } else {
        // Subsequent file_opened events should become file_updated
        processedEvent = {
          type: "file_updated",
          handle: event.handle,
          content: event.content,
        };
      }
    }

    // Skip file_updated events that don't change content
    if (
      processedEvent &&
      processedEvent.type === "file_updated" &&
      processedEvent.content === this._lastContent
    ) {
      return; // Skip this event
    }

    if (processedEvent) {
      // Update lastContent for duplicate prevention
      this._lastContent = processedEvent.content;

      this.eventQueue.push(processedEvent);

      // Notify pending generator
      if (this.pendingResolver) {
        const resolver = this.pendingResolver;
        this.pendingResolver = null;
        resolver();
      }
    }
  }

  async writeFile(oldContent: string, newContent: string): Promise<string> {
    if (this.closed) {
      throw new FileSystemError("Cannot write to closed file");
    }

    return this.fileSystem._writeFile(this.handle, oldContent, newContent);
  }

  close(): void {
    if (this.closed) return;

    this.closed = true;

    // Fire-and-forget close operation
    this.openPromise
      .then(() => {
        // File was successfully opened, send close command
        return this.fileSystem._closeFile(this.handle);
      })
      .catch(() => {
        // File opening failed, just remove from tracking without sending close
        this.fileSystem._removeFile(this.handle);
      })
      .catch((error) => {
        console.warn(`Failed to close file ${this.handle}:`, error);
      });

    // Notify pending generator to stop immediately
    if (this.pendingResolver) {
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      resolver();
    }
  }
}

class FileSystem {
  private ws: WebSocket | null = null;
  private url: string;
  private state: FileSystemState = FileSystemState.DISCONNECTED;
  private stateListeners: Set<StateListener> = new Set();
  private pendingCommands: PendingCommand[] = []; // FIFO queue for command responses
  private openFiles: Map<string, FileImpl> = new Map(); // Track open files by handle
  private connectionPromise: Promise<void> | null = null;
  private reconnectTimeoutId: number | null = null;
  private reconnectDelay: number = 5000;
  private handleCounter = 0; // Simple counter for generating handles

  constructor(url: string) {
    this.url = url;
  }

  getState(): FileSystemState {
    return this.state;
  }

  addStateListener(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // Call immediately with current state
    listener(this.state);

    return () => {
      this.stateListeners.delete(listener);
    };
  }

  openFile(path: string): File {
    const handle = String(++this.handleCounter);
    const file = new FileImpl(this, path, handle);
    this.openFiles.set(handle, file);
    return file;
  }

  async commit(message: string): Promise<void> {
    const command: CommitCommand = {
      type: "commit",
      message,
    };

    const response = await this.sendCommand(command);

    if (response.type === "committed") {
      return;
    }

    if (response.type === "error") {
      throw new FileSystemError(response.message);
    }

    throw new FileSystemError(`Unexpected response type: ${response.type}`);
  }

  async connectNow(): Promise<void> {
    return this.connect();
  }

  disconnect(): void {
    // Clear reconnection timeout
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    // Close WebSocket connection
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState(FileSystemState.DISCONNECTED);
  }

  // Internal methods

  _removeFile(handle: string) {
    this.openFiles.delete(handle);
  }

  private setState(newState: FileSystemState) {
    if (this.state !== newState) {
      this.state = newState;
      this.stateListeners.forEach((listener) => listener(newState));
    }
  }

  private connect(): Promise<void> {
    // If already connected, return resolved promise
    if (this.state === FileSystemState.CONNECTED) {
      return Promise.resolve();
    }

    // If connection is already in progress, return the existing promise
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    // Clear any pending reconnection timeout
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }

    // Create new connection promise
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      this.setState(FileSystemState.CONNECTING);

      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = async () => {
          this.setState(FileSystemState.CONNECTED);
          this.reconnectDelay = 5000; // Reset reconnect delay on successful connection

          // Reestablish open files on reconnection
          await this.reestablishOpenFiles();

          this.connectionPromise = null;
          resolve();
        };

        this.ws.onclose = () => {
          this.ws = null;
          this.connectionPromise = null;

          // Reject all pending commands
          this.pendingCommands.forEach(({ reject }) => {
            reject(new ConnectionClosedError("Connection closed"));
          });
          this.pendingCommands.length = 0;

          // Start reconnection process
          this.startReconnection();
        };

        this.ws.onerror = (event) => {
          this.ws = null;
          this.connectionPromise = null;

          reject(
            new FileSystemError(
              "WebSocket connection failed",
              undefined,
              event as any,
            ),
          );

          // Start reconnection process
          this.startReconnection();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.connectionPromise = null;
        reject(
          new FileSystemError(
            "Failed to create WebSocket",
            undefined,
            error as Error,
          ),
        );

        // Start reconnection process
        this.startReconnection();
      }
    });

    return this.connectionPromise;
  }

  private startReconnection() {
    // Only start reconnection if we have open files
    if (this.openFiles.size === 0) {
      this.setState(FileSystemState.DISCONNECTED);
      return;
    }

    this.setState(FileSystemState.RECONNECT_WAIT);

    // Schedule automatic reconnection with exponential backoff
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null;

      // Try to reconnect
      this.connect().catch(() => {
        // Connection failed, increase delay and try again
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 300000); // Cap at 5 minutes
        this.startReconnection();
      });
    }, this.reconnectDelay) as any;
  }

  private async reestablishOpenFiles() {
    if (this.openFiles.size === 0) {
      return;
    }

    // Send open_file commands only for files that have actually been opened before
    // The response will be handled by the normal message flow
    for (const [handle, file] of this.openFiles) {
      // Only reestablish files that have been opened previously
      if ((file as any).hasBeenOpened) {
        const command: OpenFileCommand = {
          type: "open_file",
          path: file.path,
          handle,
        };

        try {
          await this.sendCommand(command);
        } catch (error) {
          console.warn(`Failed to reestablish file ${file.path}:`, error);
        }
      }
    }
  }

  private handleMessage(data: string) {
    try {
      const event: ServerEvent = JSON.parse(data);

      // Handle file events that should be sent to specific files
      if (
        event.type === "file_opened" ||
        event.type === "file_updated" ||
        event.type === "file_written"
      ) {
        const fileEvent = event as FileEvent;
        const file = this.openFiles.get(fileEvent.handle);

        if (file) {
          file._addEvent(fileEvent);
        }

        // If this was in response to a command, also resolve the pending command
        if (event.type === "file_opened" || event.type === "file_written") {
          this.resolveCommand(event);
        }

        return;
      }

      // Handle other command responses
      this.resolveCommand(event);
    } catch (error) {
      console.error("Failed to parse WebSocket message:", error);
    }
  }

  private resolveCommand(event: ServerEvent) {
    const pending = this.pendingCommands.shift();
    if (pending) {
      pending.resolve(event);
    }
  }

  private sendCommand(command: ClientCommand): Promise<ServerEvent> {
    return new Promise(async (resolve, reject) => {
      try {
        // Ensure connection
        await this.connect();

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          throw new ConnectionClosedError("Connection not available");
        }

        // Add to pending commands
        this.pendingCommands.push({ resolve, reject });

        // Send command
        this.ws.send(JSON.stringify(command));
      } catch (error) {
        reject(error);
      }
    });
  }

  async _openFile(path: string, handle: string): Promise<void> {
    const command: OpenFileCommand = {
      type: "open_file",
      path,
      handle,
    };

    const response = await this.sendCommand(command);

    if (response.type === "file_opened") {
      // Event will be handled by handleMessage, don't add it here
      return;
    }

    if (response.type === "error") {
      throw new FileSystemError(response.message, path);
    }

    throw new FileSystemError(`Unexpected response type: ${response.type}`);
  }

  async _writeFile(
    handle: string,
    lastContent: string,
    newContent: string,
  ): Promise<string> {
    const command: WriteFileCommand = {
      type: "write_file",
      handle,
      last_content: lastContent,
      new_content: newContent,
    };

    const response = await this.sendCommand(command);

    if (response.type === "file_written") {
      const writeResponse = response as FileWrittenEvent;
      // The file event will be handled by handleMessage and sent to the file
      return writeResponse.content;
    }

    if (response.type === "error") {
      throw new FileSystemError(response.message);
    }

    throw new FileSystemError(`Unexpected response type: ${response.type}`);
  }

  async _closeFile(handle: string): Promise<void> {
    const command: CloseFileCommand = {
      type: "close_file",
      handle,
    };

    try {
      const response = await this.sendCommand(command);

      if (response.type === "file_closed") {
        this.openFiles.delete(handle);
        return;
      }

      if (response.type === "error") {
        throw new FileSystemError(response.message);
      }

      throw new FileSystemError(`Unexpected response type: ${response.type}`);
    } finally {
      // Always remove from tracking, even if close failed
      this.openFiles.delete(handle);
    }
  }
}

export default FileSystem;
