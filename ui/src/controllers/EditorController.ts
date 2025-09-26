import FileSystem, { File, FileEvent } from "../filesystem";
import type { editor as MonacoEditorType, IDisposable } from "monaco-editor";
import { monaco } from "../monaco-setup";

type ContentsChangedListener = (contents: string) => void;

export class EditorController {
  private workingFile: File | null = null;
  private committedFile: File | null = null;
  private editorCleanups: IDisposable[] = []; // Track editor listener disposals

  // Three-way content split:
  private _localContents = ""; // Current editor value (user's edits)
  private _remoteContents = ""; // Latest from server (working file)
  private _committedContents = ""; // Latest committed version (@file)

  // Monaco models
  private _workingModel: MonacoEditorType.ITextModel | null = null;
  private _committedModel: MonacoEditorType.ITextModel | null = null;

  private localListeners = new Set<ContentsChangedListener>();
  private committedListeners = new Set<ContentsChangedListener>();
  private autoSaveTimeoutId: number | null = null;
  private disposed = false;

  constructor(
    private fs: FileSystem,
    private path: string,
  ) {
    this.initModels();
    this.init();
  }

  private initModels() {
    // Create Monaco text models
    this._workingModel = monaco.editor.createModel(
      "", // Start with empty content, will be updated by file events
      "markdown",
    );

    this._committedModel = monaco.editor.createModel(
      "", // Start with empty content, will be updated by file events
      "markdown",
    );

    // Listen to working model content changes for local edits
    this._workingModel.onDidChangeContent(() => {
      const newContent = this._workingModel?.getValue() || "";
      this.updateLocalContents(newContent);
    });
  }

  getWorkingModel(): MonacoEditorType.ITextModel {
    if (!this._workingModel) {
      throw new Error("Working model not initialized");
    }
    return this._workingModel;
  }

  getCommittedModel(): MonacoEditorType.ITextModel {
    if (!this._committedModel) {
      throw new Error("Committed model not initialized");
    }
    return this._committedModel;
  }

  private async init() {
    try {
      // Open both working and committed versions
      this.workingFile = this.fs.openFile(this.path);
      this.committedFile = this.fs.openFile(`@${this.path}`);

      // Start listening for events
      this.watchFile(this.workingFile, (content) => {
        console.debug("New content from working file:", content);
        this._remoteContents = content;
        // For now, simple last-wins: update local content to match remote
        // TODO: Implement proper merging algorithm
        this._localContents = content;
        console.debug("Local contents updated to:", this._localContents);

        // Update the working model - this will automatically update any connected editors
        if (this._workingModel) {
          // Temporarily disable the model change listener to avoid recursive updates
          const currentValue = this._workingModel.getValue();
          if (currentValue !== content) {
            this._workingModel.setValue(content);
          }
        }

        this.notifyLocalListeners();
      });

      this.watchFile(this.committedFile, (content) => {
        this._committedContents = content;

        // Update the committed model
        if (this._committedModel) {
          const currentValue = this._committedModel.getValue();
          if (currentValue !== content) {
            this._committedModel.setValue(content);
          }
        }

        this.notifyCommittedListeners();
      });
    } catch (error) {
      console.error("Failed to initialize EditorController:", error);
    }
  }

  private async watchFile(file: File, onUpdate: (content: string) => void) {
    try {
      for await (const event of file.getEvents()) {
        if (this.disposed) break;

        onUpdate(event.content);
      }
    } catch (error) {
      if (!this.disposed) {
        console.error(`Error watching file ${file.path}:`, error);
      }
    }
  }

  get localContents(): string {
    return this._localContents;
  }

  get committedContents(): string {
    return this._committedContents;
  }

  updateLocalContents(newContent: string) {
    if (this._localContents === newContent) return;

    console.debug("updateLocalContents: updated to:", newContent);
    this._localContents = newContent;
    this.notifyLocalListeners();

    // Cancel previous auto-save and schedule new one
    if (this.autoSaveTimeoutId) {
      clearTimeout(this.autoSaveTimeoutId);
    }

    this.autoSaveTimeoutId = setTimeout(() => {
      this.save();
    }, 10000) as any; // 10 seconds
  }

  private async save() {
    if (!this.workingFile || this.disposed) return;

    try {
      // Use the remote contents as the "old" content for proper merging
      const result = await this.workingFile.writeFile(
        this._remoteContents,
        this._localContents,
      );
      // The file_written event will update _remoteContents automatically
      console.log("File saved successfully");
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  }

  addLocalContentsChangedListener(
    listener: ContentsChangedListener,
  ): () => void {
    this.localListeners.add(listener);

    return () => {
      this.localListeners.delete(listener);
    };
  }

  addCommittedContentsChangedListener(
    listener: ContentsChangedListener,
  ): () => void {
    this.committedListeners.add(listener);

    return () => {
      this.committedListeners.delete(listener);
    };
  }

  private notifyLocalListeners() {
    this.localListeners.forEach((listener) => listener(this._localContents));
  }

  private notifyCommittedListeners() {
    this.committedListeners.forEach((listener) =>
      listener(this._committedContents),
    );
  }

  dispose() {
    this.disposed = true;

    if (this.autoSaveTimeoutId) {
      clearTimeout(this.autoSaveTimeoutId);
      this.autoSaveTimeoutId = null;
    }

    // Dispose Monaco models
    if (this._workingModel) {
      this._workingModel.dispose();
      this._workingModel = null;
    }

    if (this._committedModel) {
      this._committedModel.dispose();
      this._committedModel = null;
    }

    if (this.workingFile) {
      this.workingFile.close();
      this.workingFile = null;
    }

    if (this.committedFile) {
      this.committedFile.close();
      this.committedFile = null;
    }

    this.localListeners.clear();
    this.committedListeners.clear();
  }
}
