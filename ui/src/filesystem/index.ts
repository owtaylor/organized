import {
  ServerEvent,
  ClientCommand,
  FileEvent,
  FileSystemState,
  FileSystemError,
  WriteFileCommand,
  CommitCommand,
  FileWrittenEvent,
  CommittedEvent,
} from "./types.js";

export type { FileEvent, FileSystemState };
export { FileSystemError };

type StateListener = (state: FileSystemState) => void;

interface PendingCommand {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
}

class FileSystem {
  private ws: WebSocket | null = null;
  private url: string;
  private state: FileSystemState = FileSystemState.DISCONNECTED;
  private stateListeners: Set<StateListener> = new Set();
  private pendingCommands: PendingCommand[] = []; // FIFO queue for command responses

  constructor(url: string) {
    this.url = url;
  }

  private setState(newState: FileSystemState) {
    if (this.state !== newState) {
      this.state = newState;
      this.stateListeners.forEach(listener => listener(newState));
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
            reject(new FileSystemError("Connection closed"));
          });
          this.pendingCommands.length = 0;
        };
        
        this.ws.onerror = (event) => {
          this.setState(FileSystemState.DISCONNECTED);
          this.ws = null;
          reject(new FileSystemError("WebSocket connection failed", undefined, event as any));
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (error) {
        this.setState(FileSystemState.DISCONNECTED);
        reject(new FileSystemError("Failed to create WebSocket", undefined, error as Error));
      }
    });
  }

  private handleMessage(data: string) {
    try {
      const event: ServerEvent = JSON.parse(data);
      
      // Handle file_updated events separately (these are not responses to commands)
      if (event.type === "file_updated") {
        // TODO: Handle file updates for open files in phase 6b
        return;
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
        pendingCommand.reject(new FileSystemError("Failed to parse server response", undefined, error as Error));
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
        reject(new FileSystemError("Failed to send command", undefined, error as Error));
      }
    });
  }

  async writeFile(path: string, lastContent: string, newContent: string): Promise<string> {
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

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState(FileSystemState.DISCONNECTED);
  }
}

export default FileSystem;