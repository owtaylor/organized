// TypeScript type definitions for the filesystem WebSocket protocol

// Server events sent to clients
export type ServerEvent =
  | FileOpenedEvent
  | FileClosedEvent
  | FileUpdatedEvent
  | FileWrittenEvent
  | CommittedEvent
  | ErrorEvent;

export interface FileOpenedEvent {
  type: "file_opened";
  path: string;
  handle: string;
  content: string;
}

export interface FileClosedEvent {
  type: "file_closed";
  handle: string;
}

export interface FileUpdatedEvent {
  type: "file_updated";
  handle: string;
  content: string;
}

export interface FileWrittenEvent {
  type: "file_written";
  handle: string;
  content: string;
}

export interface CommittedEvent {
  type: "committed";
}

export interface ErrorEvent {
  type: "error";
  path?: string;
  message: string;
}

// Client commands sent to server
export type ClientCommand =
  | OpenFileCommand
  | CloseFileCommand
  | WriteFileCommand
  | CommitCommand;

export interface OpenFileCommand {
  type: "open_file";
  path: string;
  handle: string;
}

export interface CloseFileCommand {
  type: "close_file";
  handle: string;
}

export interface WriteFileCommand {
  type: "write_file";
  handle: string;
  last_content: string;
  new_content: string;
}

export interface CommitCommand {
  type: "commit";
  message: string;
}

// File events that are exposed to the client API
export type FileEvent = FileOpenedEvent | FileUpdatedEvent | FileWrittenEvent;

// FileSystem connection states
export enum FileSystemState {
  CONNECTING = "CONNECTING",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
  RECONNECT_WAIT = "RECONNECT_WAIT",
}

// FileSystem error types
export class FileSystemError extends Error {
  constructor(
    message: string,
    public path?: string,
    public originalError?: Error,
  ) {
    super(message);
    this.name = "FileSystemError";
  }
}

export class ConnectionClosedError extends FileSystemError {
  constructor(
    message: string,
    public originalError?: Error,
  ) {
    super(message, undefined, originalError);
    this.name = "ConnectionClosedError";
  }
}

// File interface for the revised client API
export interface File {
  // Get async generator for file events
  getEvents(): AsyncGenerator<FileEvent>;

  // Write to the file
  writeFile(oldContent: string, newContent: string): Promise<string>;

  // Close the file handle (explicit cleanup)
  close(): void;

  // Get the path for this file
  readonly path: string;
}
